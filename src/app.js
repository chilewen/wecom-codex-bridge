import { URL } from 'node:url';

import { unwrapCallback } from './wecom-crypto.js';
import { parseXml } from './wecom.js';

const MAX_BODY_BYTES = 1024 * 1024;
const DEDUPE_TTL_MS = 10 * 60 * 1000;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body, contentType = 'text/plain; charset=utf-8') {
  if (typeof res.writeHead === 'function') {
    res.writeHead(status, { 'content-type': contentType });
    res.end(body);
    return;
  }
  res.status = status;
  res.body = body;
  res.end?.(body);
}

/**
 * Builds the HTTP request handler. Kept free of sockets so the whole callback
 * path (verification, decryption, dispatch) can be exercised without binding a
 * port.
 */
export function createRequestHandler({ config, bridge, projects, logger = console }) {
  // WeCom retries the same message up to 3 times; ignore duplicates.
  const seenMessages = new Map();
  function isDuplicate(key) {
    if (!key) return false;
    const now = Date.now();
    for (const [k, ts] of seenMessages) {
      if (now - ts > DEDUPE_TTL_MS) seenMessages.delete(k);
    }
    if (seenMessages.has(key)) return true;
    seenMessages.set(key, now);
    return false;
  }

  function cryptoOptions() {
    return {
      token: config.wecom.token,
      encodingAESKey: config.wecom.encodingAESKey,
      strictReceiveId: config.wecom.strictReceiveId,
      expectedReceiveId: config.wecom.receiveId || config.wecom.corpId,
    };
  }

  async function handleVerification(res, url) {
    const params = Object.fromEntries(url.searchParams.entries());
    try {
      // For the GET handshake the signature is computed over `echostr`, and the
      // decrypted plaintext is the value WeCom expects echoed back verbatim.
      const { message } = unwrapCallback({
        ...cryptoOptions(),
        query: { ...params, encrypt: params.echostr },
      });
      logger.log('[wecom] URL verification succeeded');
      send(res, 200, message);
    } catch (err) {
      logger.error(`[wecom] URL verification failed: ${err.message}`);
      send(res, err.status ?? 400, 'verification failed');
    }
  }

  async function handleMessage(req, res, url) {
    const params = Object.fromEntries(url.searchParams.entries());
    const body = await readBody(req);

    // The signature covers the encrypted payload inside the body, not the query.
    const envelope = parseXml(body);
    const encrypt = envelope.Encrypt ?? envelope.encrypt;
    if (!encrypt) {
      logger.error('[wecom] callback body had no <Encrypt>');
      send(res, 400, 'missing Encrypt');
      return;
    }

    let decrypted;
    try {
      decrypted = unwrapCallback({ ...cryptoOptions(), query: { ...params, encrypt }, body });
    } catch (err) {
      logger.error(`[wecom] message decryption failed: ${err.message}`);
      send(res, err.status ?? 400, 'bad request');
      return;
    }

    // Answer immediately: WeCom requires a response within 5 seconds while a
    // Codex run can take minutes. Results are pushed proactively instead.
    send(res, 200, '');

    const message = parseXml(decrypted.message);
    const userId = message.FromUserName;
    const msgType = message.MsgType;
    const content = message.Content ?? '';

    if (!userId) {
      logger.error('[wecom] message had no FromUserName, ignored');
      return;
    }
    logger.log(`[wecom] <- ${userId} (${msgType}) ${JSON.stringify(content).slice(0, 120)}`);

    if (isDuplicate(message.MsgId)) {
      logger.log('[wecom] duplicate MsgId, skipped');
      return;
    }

    if (msgType === 'event') return; // enter_chat and friends need no reply
    const ctx = { userId, source: 'callback' };
    if (msgType !== 'text') {
      await bridge.send(ctx, '目前只支持文字消息。').catch(() => {});
      return;
    }

    try {
      await bridge.handle(userId, content, ctx);
    } catch (err) {
      logger.error('[wecom] handler crashed:', err);
      await bridge.send(ctx, `❌ 内部错误：${err.message}`).catch(() => {});
    }
  }

  return async function handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers?.host ?? 'localhost'}`);

    if (url.pathname === '/health') {
      send(res, 200, JSON.stringify({ ok: true, projects: projects.length, running: bridge.running.size }), 'application/json');
      return;
    }

    if (url.pathname !== config.server.path) {
      send(res, 404, 'not found');
      return;
    }

    try {
      if (req.method === 'GET') await handleVerification(res, url);
      else if (req.method === 'POST') await handleMessage(req, res, url);
      else send(res, 405, 'method not allowed');
    } catch (err) {
      logger.error('[server] unhandled error:', err);
      if (!res.headersSent) send(res, 500, 'internal error');
    }
  };
}
