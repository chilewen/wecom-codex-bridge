/**
 * Writes an HTTP/1.1 WebSocket upgrade request by hand over a raw TLS socket.
 *
 * This exists because Node's own HTTP client cannot complete this handshake
 * against WeCom: an identical request through `https.request` gets `404` while
 * the hand-written bytes get `101`. Both `diagnose` and `ws-probe` use this so
 * they report what the real transport does, not what Node's client does.
 */
import crypto from 'node:crypto';
import tls from 'node:tls';

export function rawUpgrade({
  host,
  port = 443,
  path = '/',
  extraHeaders = {},
  key = crypto.randomBytes(16).toString('base64'),
  timeoutMs = 12000,
} = {}) {
  return new Promise((resolve) => {
    const lines = [
      `GET ${path} HTTP/1.1`,
      `Host: ${host}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${key}`,
      ...Object.entries(extraHeaders).map(([name, value]) => `${name}: ${value}`),
    ];
    const payload = `${lines.join('\r\n')}\r\n\r\n`;

    const socket = tls.connect({ host, port, servername: host }, () => socket.write(payload));
    let buffer = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const end = buffer.indexOf('\r\n\r\n');
      if (end >= 0) finish({ ok: true, head: buffer.slice(0, end) });
      else if (buffer.length > 4096) finish({ ok: true, head: buffer.slice(0, 400) });
    });
    socket.on('error', (err) => finish({ ok: false, error: err.message }));
    socket.setTimeout(timeoutMs, () => finish({ ok: false, error: `${timeoutMs}ms 内没有任何回应（socket 一直开着）` }));
  });
}

/** `head` -> { status, statusText, headers } */
export function parseHead(head) {
  const [statusLine, ...rest] = String(head).split('\r\n');
  const matched = /^HTTP\/1\.\d (\d{3}) ?(.*)$/.exec(statusLine.trim());
  const headers = {};
  for (const line of rest) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return {
    status: matched ? Number(matched[1]) : 0,
    statusText: matched ? matched[2] : statusLine,
    headers,
  };
}
