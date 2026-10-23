import {
  buildMarkdownBody,
  buildRespondMsgFrame,
  buildSendMsgFrame,
  buildStreamBody,
  newReqId,
} from './longconn.js';
import { chunkText, deliver } from './wecom.js';

/**
 * A transport turns Bridge output into WeCom messages.
 *
 *   send(ctx, text)          -> one finished message
 *   openStream(ctx)          -> { push(text), finish(text) }
 *
 * `ctx` carries whatever the transport needs to address the reply:
 *   { reqId, userId, chatId, chatType }
 */

// The doc gives markdown a 20480-byte budget and caps streams at 10 minutes.
const MAX_CONTENT_BYTES = 20_000;
const STREAM_MAX_MS = 9 * 60 * 1000;

function byteLength(text) {
  return Buffer.byteLength(text ?? '', 'utf8');
}

/** Cuts at a line boundary when possible so code blocks are not split mid-line. */
function cutAt(text, maxBytes) {
  if (byteLength(text) <= maxBytes) return [text, ''];
  let size = 0;
  let index = 0;
  for (const char of text) {
    const charSize = Buffer.byteLength(char, 'utf8');
    if (size + charSize > maxBytes) break;
    size += charSize;
    index += char.length;
  }
  const head = text.slice(0, index);
  const lastNewline = head.lastIndexOf('\n');
  const cut = lastNewline > head.length * 0.6 ? lastNewline : head.length;
  return [text.slice(0, cut), text.slice(cut).replace(/^\n/, '')];
}

export function createLongConnTransport({
  client,
  logger = console,
  streamThrottleMs = 1200,
  streamMaxMs = STREAM_MAX_MS,
  // @internal tests shrink these so the limits can be exercised without waiting.
  maxContentBytes = MAX_CONTENT_BYTES,
} = {}) {
  async function sendFrameWithFallback(ctx, frame, fallbackBody) {
    const res = await client.send(frame);
    if (res?.errcode === 0) return res;
    // A reply tied to a req_id only works while the callback is fresh (24h).
    // Fall back to a proactive push so results are never silently lost.
    if (ctx?.userId || ctx?.chatId) {
      logger.error(`[longconn] reply failed (${res?.errcode} ${res?.errmsg}), falling back to aibot_send_msg`);
      return client.send(buildSendMsgFrame({
        chatId: ctx.chatType === 'group' ? ctx.chatId : (ctx.userId ?? ctx.chatId),
        chatType: ctx.chatType === 'group' ? 2 : 1,
        body: fallbackBody,
      }));
    }
    return res;
  }

  async function send(ctx, text) {
    const chunks = chunkText(text, MAX_CONTENT_BYTES);
    for (const chunk of chunks) {
      const body = buildMarkdownBody(chunk);
      const frame = ctx?.reqId
        ? buildRespondMsgFrame({ reqId: ctx.reqId, body })
        : buildSendMsgFrame({
          chatId: ctx?.chatType === 'group' ? ctx.chatId : (ctx?.userId ?? ctx?.chatId),
          chatType: ctx?.chatType === 'group' ? 2 : 1,
          body,
        });
      await sendFrameWithFallback(ctx, frame, body);
    }
    return chunks.length;
  }

  function openStream(ctx) {
    const streamId = newReqId();
    let buffer = '';
    let finished = false;
    let started = false;
    let lastSentAt = 0;
    let overflowCount = 0;
    // The stream message was already closed (hit the 10-minute cap), so the
    // result has to be delivered as a normal message instead.
    let streamClosed = false;
    // Set when aibot_respond_msg is not usable (expired req_id, rate limited...).
    // Every later push would then turn into its own chat message, which looks
    // like the bot spamming progress updates - so stop streaming and deliver
    // the result once, at the end.
    let degraded = false;
    const startedAt = Date.now();
    // All updates go through this queue. Deltas arrive far faster than WeCom
    // accepts them, and two concurrent updates could send a shorter snapshot
    // after a longer one - WeCom rejects that and the bubble sticks on "...".
    let queue = Promise.resolve();

    async function pushStream(content, finish) {
      const body = buildStreamBody({ streamId, content, finish });
      const res = await client.send(buildRespondMsgFrame({ reqId: ctx?.reqId, body }));
      if (res?.errcode === 0) return true;
      degraded = true;
      logger.error(
        `[longconn] stream reply failed (${res?.errcode} ${res?.errmsg}); stopping updates, `
        + 'the result will be delivered as one message when the run finishes',
      );
      return false;
    }

    /**
     * Delivers straight to aibot_send_msg, without first retrying the
     * respond_msg path we already know is broken for this callback.
     */
    async function sendPlain(text) {
      const chunks = chunkText(text, maxContentBytes);
      for (const chunk of chunks) {
        const body = buildMarkdownBody(chunk);
        const frame = buildSendMsgFrame({
          chatId: ctx?.chatType === 'group' ? ctx.chatId : (ctx?.userId ?? ctx.chatId),
          chatType: ctx?.chatType === 'group' ? 2 : 1,
          body,
        });
        await client.send(frame);
      }
      return chunks.length;
    }

    /** Ends the stream and delivers any remainder as separate markdown messages. */
    async function flushOverflow() {
      const [head, tail] = cutAt(buffer, maxContentBytes);
      const note = tail ? '\n\n…（内容较长，剩余部分随后单独发送）' : '';
      await pushStream(head + note, true);
      streamClosed = true;
      if (tail) {
        overflowCount += 1;
        await send(ctx, tail);
      }
    }

    /** Sends the current buffer, respecting the throttle unless finishing. */
    async function sendLatest(final) {
      if (finished || degraded || streamClosed) return;
      const elapsed = Date.now() - startedAt;
      if (!started) {
        if (!buffer) return;
        if (await pushStream(buffer, final)) {
          started = true;
          lastSentAt = Date.now();
        }
        return;
      }
      if (elapsed > streamMaxMs || byteLength(buffer) > maxContentBytes) {
        await flushOverflow();
        return;
      }
      if (!final && Date.now() - lastSentAt < streamThrottleMs) return;
      if (await pushStream(buffer, final)) lastSentAt = Date.now();
    }

    /** Ends the turn: close the stream bubble, or fall back to a plain message. */
    async function finalize() {
      if (finished) return;
      if (!started && !buffer) buffer = '(没有输出)';

      // An update failed earlier, but the bubble is still open. Try to close
      // it with the full text so the user does not see a perpetual "...".
      if (degraded && !streamClosed) {
        if (await pushStream(buffer, true)) {
          finished = true;
          return;
        }
      }

      if (degraded || streamClosed) {
        finished = true;
        const chunks = await sendPlain(buffer);
        overflowCount += Math.max(0, chunks - 1);
        return;
      }

      if (byteLength(buffer) > maxContentBytes) {
        await flushOverflow();
        finished = true;
        return;
      }

      if (await pushStream(buffer, true)) {
        finished = true;
        return;
      }

      // The final close failed as well: deliver the result as its own message.
      finished = true;
      const chunks = await sendPlain(buffer);
      overflowCount += Math.max(0, chunks - 1);
    }

    return {
      get streamId() {
        return streamId;
      },
      /** True once the stream message itself has been ended. */
      isStreamClosed() {
        return streamClosed || degraded;
      },
      isFinished() {
        return finished;
      },
      isDegraded() {
        return degraded;
      },
      async push(delta) {
        if (finished || !delta) return;
        buffer += delta;
        // Nothing to push to anymore; finish() delivers the whole thing.
        if (degraded || streamClosed) return;
        queue = queue
          .then(() => sendLatest(false))
          .catch((err) => logger.error(`[longconn] stream update crashed: ${err.message}`));
        return queue;
      },
      async finish(finalText) {
        if (finished) return overflowCount;
        // WeCom renders the latest full snapshot. Sending a shorter one after
        // a longer update makes the bubble regress or the update fail, so the
        // final text may only grow relative to what was already sent.
        if (finalText != null) {
          if (byteLength(finalText) >= byteLength(buffer)) buffer = finalText;
          else if (!buffer.includes(finalText)) buffer = `${buffer}\n\n${finalText}`;
        }
        queue = queue
          .then(() => finalize())
          .catch((err) => logger.error(`[longconn] stream finish crashed: ${err.message}`));
        await queue;
        return overflowCount;
      },
    };
  }

  return { send, openStream };
}

/** Non-streaming transport for the callback/webhook path (unchanged behaviour). */
export function createWebhookTransport({ config, messenger }) {
  return {
    send(ctx, text) {
      return deliver({ config, messenger, userId: ctx?.userId, text });
    },
    openStream(ctx) {
      return {
        // This path has no native streaming, so progress lines are just messages.
        push(delta) {
          return delta ? deliver({ config, messenger, userId: ctx?.userId, text: delta }) : 0;
        },
        finish(finalText) {
          return deliver({ config, messenger, userId: ctx?.userId, text: finalText });
        },
      };
    },
  };
}

/** Prints to stdout; used by the local REPL. */
export function createConsoleTransport({ write = console.log } = {}) {
  return {
    async send(_ctx, text) {
      write(`\n🤖\n${text.replace(/^/gm, '   ')}\n`);
      return 1;
    },
    openStream(_ctx) {
      const lines = [];
      return {
        async push(delta) {
          if (delta) write(`   ↳ ${delta}`);
        },
        async finish(finalText) {
          write(`\n🤖\n${String(finalText ?? '').replace(/^/gm, '   ')}\n`);
        },
        get lines() {
          return lines;
        },
      };
    },
  };
}
