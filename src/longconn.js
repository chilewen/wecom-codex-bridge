import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import { MiniWebSocket } from './ws-client.js';

/**
 * WeCom "smart robot" long-connection (WebSocket) client.
 *
 * Protocol reference: developer.work.weixin.qq.com/document/path/101463
 * Frames are plain JSON; the transport is encrypted by wss:// so there is no
 * business-layer crypto for messages.
 */

export const DEFAULT_WS_URL = 'wss://openws.work.weixin.qq.com';

export function newReqId() {
  return crypto.randomUUID();
}

export function buildSubscribeFrame({ botId, secret, reqId = newReqId() }) {
  return { cmd: 'aibot_subscribe', headers: { req_id: reqId }, body: { bot_id: botId, secret } };
}

export function buildPingFrame(reqId = newReqId()) {
  return { cmd: 'ping', headers: { req_id: reqId } };
}

export function buildRespondMsgFrame({ reqId, body }) {
  return { cmd: 'aibot_respond_msg', headers: { req_id: reqId }, body };
}

export function buildSendMsgFrame({ chatId, chatType, body, reqId = newReqId() }) {
  const payload = { chatid: chatId, ...body };
  if (chatType === 1 || chatType === 2) payload.chat_type = chatType;
  return { cmd: 'aibot_send_msg', headers: { req_id: reqId }, body: payload };
}

export function buildWelcomeFrame({ reqId, body }) {
  return { cmd: 'aibot_respond_welcome_msg', headers: { req_id: reqId }, body };
}

/** Stream replies replace the whole message content on every push. */
export function buildStreamBody({ streamId, content, finish = false, feedbackId }) {
  const stream = { id: streamId, finish: Boolean(finish), content: content ?? '' };
  if (feedbackId) stream.feedback = { id: feedbackId };
  return { msgtype: 'stream', stream };
}

export function buildMarkdownBody(content, feedbackId) {
  const markdown = { content };
  if (feedbackId) markdown.feedback = { id: feedbackId };
  return { msgtype: 'markdown', markdown };
}

/**
 * In group chats the callback content still carries the @mention prefix
 * (e.g. "@RobotA hello robot"); strip it before handing the text to Codex.
 */
export function stripMention(content) {
  return String(content ?? '').replace(/^(?:\s*@[^\s@]+\s*)+/, '').trim();
}

/**
 * WeCom already transcribes voice messages before delivering them (voice is
 * only supported in 1:1 chats), but the transcript has appeared under a few
 * different field names across callback versions. Probe them in order rather
 * than guessing a single one.
 */
const VOICE_TEXT_FIELDS = ['content', 'text', 'recognition', 'voice_text', 'asr_text'];

export function extractMessageText(body = {}) {
  if (body.msgtype === 'text') return stripMention(body.text?.content);
  if (body.msgtype !== 'voice') return '';
  const voice = body.voice ?? {};
  for (const field of VOICE_TEXT_FIELDS) {
    const value = voice[field];
    if (typeof value === 'string' && value.trim()) return stripMention(value);
  }
  return '';
}

/**
 * Responses to our own commands carry no `cmd` - they are matched by
 * headers.req_id - so only require a JSON object here.
 */
export function parseConnectFrame(raw) {
  let frame;
  try {
    frame = JSON.parse(typeof raw === 'string' ? raw : String(raw));
  } catch {
    return null;
  }
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return null;
  return frame;
}

/**
 * @param {object} opts
 * @param {string} opts.botId
 * @param {string} opts.secret
 * @param {string} [opts.wsUrl]
 * @param {number} [opts.heartbeatMs]      default 30s per the doc
 * @param {number} [opts.pongTimeoutMs]    reconnect if a ping goes unanswered
 * @param {(url: string) => object} [opts.wsFactory]  injectable for tests
 */
export class LongConnClient extends EventEmitter {
  constructor({
    botId,
    secret,
    wsUrl = DEFAULT_WS_URL,
    heartbeatMs = 30_000,
    pongTimeoutMs = 20_000,
    requestTimeoutMs = 15_000,
    reconnectMinMs = 1_000,
    reconnectMaxMs = 60_000,
    wsFactory,
    logger = console,
  }) {
    super();
    this.botId = botId;
    this.secret = secret;
    this.wsUrl = wsUrl;
    this.heartbeatMs = heartbeatMs;
    this.pongTimeoutMs = pongTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.reconnectMinMs = reconnectMinMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.logger = logger;
    // Node's built-in WebSocket (undici) fails the handshake against
    // openws.work.weixin.qq.com with "non-101 status code" even though the
    // server answers identical requests with 101. Our own RFC 6455 client
    // talks to it fine, so it is the default transport.
    this.wsFactory = wsFactory ?? ((url) => new MiniWebSocket(url));

    this.socket = null;
    this.state = 'idle'; // idle | connecting | subscribing | ready | closed
    this.attempt = 0;
    this.pending = new Map();
    this.heartbeatTimer = null;
    this.pongTimer = null;
    this.pingReqId = null;
    this.reconnectTimer = null;
    // Set when WeCom replaced us with a newer connection. Reconnecting would
    // kick that connection straight back, so we stay down until asked.
    this.replacedByPeer = false;
  }

  get isReady() {
    return this.state === 'ready' && this.socket?.readyState === 1;
  }

  connect() {
    if (this.state === 'connecting' || this.state === 'subscribing' || this.state === 'ready') return this;
    this.state = 'connecting';
    this.replacedByPeer = false;
    this.closeHandled = false;

    let socket;
    try {
      socket = this.wsFactory(this.wsUrl);
    } catch (err) {
      this.logger.error(`[longconn] failed to open socket: ${err.message}`);
      this.scheduleReconnect();
      return this;
    }
    this.socket = socket;

    socket.onopen = () => this.handleOpen();
    socket.onmessage = (event) => this.handleFrame(event?.data);
    socket.onerror = (event) => {
      this.logger.error(`[longconn] socket error: ${event?.message ?? 'unknown'}`);
      if (this.socket !== socket) return;
      // Node's WebSocket reports a failed handshake through `error` and may
      // never fire `close`. Without this the client would hang forever after a
      // single failed connect instead of retrying.
      if (this.state === 'connecting' || this.state === 'subscribing') {
        this.finishClose({ code: 0, reason: 'handshake failed' });
      }
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.finishClose(event);
    };
    return this;
  }

  handleOpen() {
    this.state = 'subscribing';
    this.logger.log('[longconn] connected, sending aibot_subscribe');
    this.request(buildSubscribeFrame({ botId: this.botId, secret: this.secret }))
      .then((res) => {
        if (res.errcode !== 0) {
          // Bad credentials will never fix themselves by retrying fast.
          this.logger.error(`[longconn] subscribe rejected: ${res.errcode} ${res.errmsg}`);
          this.emit('subscribeFailed', res);
          return;
        }
        this.state = 'ready';
        this.attempt = 0;
        this.logger.log('[longconn] subscribed, receiving callbacks');
        this.startHeartbeat();
        this.emit('ready');
      })
      .catch((err) => this.logger.error(`[longconn] subscribe failed: ${err.message}`));
  }

  handleFrame(raw) {
    const frame = parseConnectFrame(raw);
    if (!frame) {
      this.logger.error('[longconn] dropped a frame that was not JSON');
      return;
    }

    const reqId = frame.headers?.req_id;
    if (reqId && this.pending.has(reqId)) {
      const { resolve, timer } = this.pending.get(reqId);
      this.pending.delete(reqId);
      clearTimeout(timer);
      resolve(frame);
      return;
    }

    switch (frame.cmd) {
      case 'aibot_msg_callback':
        this.emit('message', frame);
        break;
      case 'aibot_event_callback':
        if (frame.body?.event?.eventtype === 'disconnected_event') {
          this.replacedByPeer = true;
          this.logger.error('[longconn] kicked: another connection subscribed with the same BotID. Not reconnecting.');
          this.emit('replaced', frame);
        }
        this.emit('event', frame);
        break;
      case 'pong':
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
        break;
      default:
        this.emit('frame', frame);
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.ping(), this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    clearTimeout(this.pongTimer);
    this.pongTimer = null;
    this.pingReqId = null;
  }

  /**
   * The server answers our ping by echoing `headers.req_id`, and those replies
   * are consumed by the generic pending-request matcher in handleFrame - they
   * never reach `case 'pong'`. So the timeout has to be cleared here, from the
   * matched reply, otherwise a perfectly healthy connection reconnects every
   * `pongTimeoutMs` forever.
   */
  ping() {
    if (!this.isReady) return;
    const reqId = newReqId();
    this.pingReqId = reqId;

    clearTimeout(this.pongTimer);
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      this.logger.error(
        `[longconn] heartbeat timed out: no answer to our ping within ${this.pongTimeoutMs}ms, reconnecting`,
      );
      this.close({ reconnect: true });
    }, this.pongTimeoutMs);
    this.pongTimer.unref?.();

    this.request(buildPingFrame(reqId))
      .then((res) => {
        if (this.pingReqId !== reqId) return; // a newer ping already took over
        this.pingReqId = null;
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
        this.emit('pong', res);
      })
      .catch((err) => {
        // Leave the timer armed: an unanswered ping means a dead link, which is
        // exactly what the heartbeat is for.
        this.logger.error(`[longconn] ping failed: ${err.message}`);
      });
  }

  /** Sends a frame and resolves with its response frame. */
  request(frame) {
    const reqId = frame.headers?.req_id ?? newReqId();
    if (!frame.headers) frame.headers = {};
    frame.headers.req_id = reqId;

    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== 1) {
        reject(new Error('socket is not open'));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`no response for ${frame.cmd} within ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(reqId, { resolve, reject, timer, cmd: frame.cmd });
      try {
        this.socket.send(JSON.stringify(frame));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(reqId);
        reject(err);
      }
    });
  }

  /**
   * Resolves once the client is ready to send, or rejects after `timeoutMs`.
   * Used so a reply is not dropped just because it landed in the gap while the
   * socket was reconnecting.
   */
  waitUntilReady(timeoutMs = 5000) {
    if (this.isReady) return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      const onReady = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.off('ready', onReady);
        reject(new Error(`not connected (waited ${timeoutMs}ms)`));
      }, timeoutMs);
      timer.unref?.();
      this.once('ready', onReady);
    });
  }

  /** Fire-and-forget send for replies whose errors we only want logged. */
  async send(frame) {
    if (!this.isReady) {
      // Give a reconnect a moment to land rather than losing the message.
      await this.waitUntilReady(5000).catch(() => {});
    }
    return this.request(frame).catch((err) => {
      this.logger.error(`[longconn] ${frame.cmd} failed: ${err.message}`);
      return { errcode: -1, errmsg: err.message };
    });
  }

  finishClose(event) {
    if (this.closeHandled) return;
    this.closeHandled = true;
    this.stopHeartbeat();
    for (const [reqId, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`connection closed before ${entry.cmd} responded`));
      this.pending.delete(reqId);
    }
    const wasReady = this.state === 'ready';
    this.socket = null;
    if (this.state !== 'closed') this.state = 'idle';
    this.emit('close', { code: event?.code, reason: event?.reason });
    if (wasReady) this.logger.error(`[longconn] connection closed (code ${event?.code ?? '?'})`);
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.state === 'closed' || this.reconnectTimer) return;
    if (this.replacedByPeer) {
      this.logger.error('[longconn] not reconnecting: this bot was taken over by another connection');
      return;
    }
    const delay = Math.min(this.reconnectMaxMs, this.reconnectMinMs * 2 ** this.attempt);
    const jittered = Math.round(delay * (0.5 + Math.random() * 0.5));
    this.attempt += 1;
    this.logger.log(`[longconn] reconnecting in ${jittered}ms (attempt ${this.attempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, jittered);
    this.reconnectTimer.unref?.();
  }

  close({ reconnect = false } = {}) {
    this.stopHeartbeat();
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (!reconnect) this.state = 'closed';
    else this.state = 'idle';
    try {
      this.socket?.close(1000, 'client closing');
    } catch {
      /* ignore */
    }
    this.socket = null;
    if (reconnect) this.scheduleReconnect();
  }
}
