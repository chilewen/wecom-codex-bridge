import { buildMarkdownBody, buildRespondMsgFrame, stripMention } from './longconn.js';

export const DEFAULT_WELCOME = [
  '你好，我是接在 Codex 上的机器人。',
  '',
  '直接发消息即可提问，我会在你选定的工作目录里执行。',
  '先发送 /projects 选一个项目；不想绑定仓库就发 /none，用「无项目」模式。',
  '/help 查看全部命令。',
].join('\n');

const DEDUPE_TTL_MS = 10 * 60 * 1000;

/**
 * Wires long-connection callbacks into the Bridge. Kept separate from the
 * entry point so it can be driven by tests and reused by other runners.
 */
export function attachLongConnBot({ client, bridge, transport, logger = console, welcome = DEFAULT_WELCOME }) {
  const seenMessages = new Map();

  function isDuplicate(msgId) {
    if (!msgId) return false;
    const now = Date.now();
    for (const [key, ts] of seenMessages) {
      if (now - ts > DEDUPE_TTL_MS) seenMessages.delete(key);
    }
    if (seenMessages.has(msgId)) return true;
    seenMessages.set(msgId, now);
    return false;
  }

  async function onMessage(frame) {
    const body = frame.body ?? {};
    const ctx = {
      reqId: frame.headers?.req_id,
      userId: body.from?.userid,
      chatId: body.chatid,
      chatType: body.chattype,
      source: 'longconn',
    };
    const text = stripMention(body.text?.content);
    logger.log(`[bot] <- ${ctx.userId} (${body.chattype}/${body.msgtype}) ${JSON.stringify(text).slice(0, 120)}`);

    if (isDuplicate(body.msgid)) return;
    if (!ctx.userId) {
      logger.error('[bot] message had no from.userid, ignored');
      return;
    }
    if (body.msgtype !== 'text') {
      await client
        .send(buildRespondMsgFrame({ reqId: ctx.reqId, body: buildMarkdownBody('目前只支持文字消息。') }))
        .catch(() => {});
      return;
    }
    try {
      await bridge.handle(ctx.userId, text, ctx);
    } catch (err) {
      logger.error(`[bot] handler crashed: ${err.message}`);
      await transport.send(ctx, `❌ 内部错误：${err.message}`).catch(() => {});
    }
  }

  async function onEvent(frame) {
    if (frame.body?.event?.eventtype === 'enter_chat') {
      await client
        .send({ cmd: 'aibot_respond_welcome_msg', headers: { req_id: frame.headers?.req_id }, body: buildMarkdownBody(welcome) })
        .catch(() => {});
    }
  }

  client.on('message', onMessage);
  client.on('event', onEvent);
  return { isDuplicate, onMessage, onEvent };
}
