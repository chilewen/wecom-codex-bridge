import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

/**
 * Minimal RFC 6455 WebSocket client built directly on node:tls / node:net.
 *
 * Why not the built-in WebSocket: its undici implementation fails the handshake
 * against openws.work.weixin.qq.com ("Received network error or non-101 status
 * code") even though the server happily returns 101 to an identical request
 * made with curl.
 *
 * Why not node:https either: WeCom's server answers `HTTP 404` to an upgrade
 * request sent through Node's HTTP client, while the *same bytes* written to
 * the same TLS socket by hand get `101`. Verified with scripts/ws-probe.js -
 * raw TLS wins every variant, https.request loses every variant. So we build
 * the socket ourselves and write the request line by hand; that leaves no layer
 * between us and the server to second-guess the framing.
 *
 * Only text frames plus ping/pong/close are needed.
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 8 * 1024 * 1024;

export const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

export function acceptKeyFor(secWebSocketKey) {
  return crypto.createHash('sha1').update(secWebSocketKey + GUID).digest('base64');
}

/** Client-to-server frames must be masked. */
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const length = body.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  header[1] |= 0x80; // mask bit

  const mask = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) masked[i] = body[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/**
 * Incremental frame parser. Feed it whatever arrives on the socket; it returns
 * the complete frames it could decode plus the unconsumed remainder.
 */
/** Returned when the buffered bytes are too short to decode the next frame. */
const NEED_MORE = Symbol('need-more-bytes');

export function createFrameParser() {
  let buffer = Buffer.alloc(0);
  let fragmentOpcode = null;
  let fragments = [];

  // Returns a decoded frame, null when a frame was consumed without completing
  // a message (an in-progress fragment), or NEED_MORE when more bytes are
  // required. `push` must keep looping past null, otherwise a fragment inside a
  // batch would stall every frame behind it.
  function parseOne() {
    if (buffer.length < 2) return NEED_MORE;
    const first = buffer[0];
    const second = buffer[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (buffer.length < offset + 2) return NEED_MORE;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length < offset + 8) return NEED_MORE;
      const big = buffer.readBigUInt64BE(offset);
      if (big > BigInt(MAX_PAYLOAD)) throw new Error(`frame too large: ${big} bytes`);
      length = Number(big);
      offset += 8;
    }
    if (length > MAX_PAYLOAD) throw new Error(`frame too large: ${length} bytes`);

    let maskKey = null;
    if (masked) {
      if (buffer.length < offset + 4) return NEED_MORE;
      maskKey = buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buffer.length < offset + length) return NEED_MORE;

    let payload = buffer.subarray(offset, offset + length);
    if (maskKey) {
      const out = Buffer.allocUnsafe(length);
      for (let i = 0; i < length; i += 1) out[i] = payload[i] ^ maskKey[i % 4];
      payload = out;
    }
    buffer = buffer.subarray(offset + length);

    // Control frames may interleave with fragmented data frames.
    if (opcode === OPCODE.CLOSE || opcode === OPCODE.PING || opcode === OPCODE.PONG) {
      return { fin: true, opcode, payload };
    }
    if (opcode === OPCODE.CONTINUATION) {
      fragments.push(payload);
      if (!fin) return null;
      const full = Buffer.concat(fragments);
      fragments = [];
      const completeOpcode = fragmentOpcode;
      fragmentOpcode = null;
      return { fin: true, opcode: completeOpcode, payload: full };
    }
    if (!fin) {
      fragmentOpcode = opcode;
      fragments = [payload];
      return null;
    }
    return { fin, opcode, payload };
  }

  return {
    push(chunk) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      const frames = [];
      for (;;) {
        const frame = parseOne();
        if (frame === NEED_MORE) break;
        if (frame) frames.push(frame);
      }
      return frames;
    },
  };
}

/** Opens the transport socket. Overridable so tests can inject a fake. */
function defaultConnect({ host, port, servername, secure }) {
  if (!secure) return net.connect({ host, port });
  return tls.connect({ host, port, servername });
}

export class MiniWebSocket {
  /**
   * @param {string} url
   * @param {object} [opts]
   * @param {Record<string,string>} [opts.headers]          extra handshake headers
   * @param {number} [opts.handshakeTimeoutMs]
   * @param {number} [opts.maxPayload]
   * @param {(opts: {host: string, port: number, servername: string, secure: boolean}) => import('node:stream').Duplex} [opts.connect]
   */
  constructor(url, { headers = {}, handshakeTimeoutMs = 15000, maxPayload = MAX_PAYLOAD, connect } = {}) {
    this.url = url;
    this.extraHeaders = headers;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.maxPayload = maxPayload;
    this.connectImpl = connect ?? defaultConnect;

    this.readyState = 0; // 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;

    this.socket = null;
    this.parser = createFrameParser();
    this.handshakeDone = false;
    this.requestSent = false;
    this.headBuffer = Buffer.alloc(0);
    this.pendingRefusal = null;
    this.refusalBody = Buffer.alloc(0);

    this.#dial();
  }

  #emitClose(code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    clearTimeout(this.handshakeTimer);
    try {
      this.onclose?.({ code, reason });
    } catch {
      /* listener errors must not break the socket */
    }
  }

  #fail(err) {
    clearTimeout(this.handshakeTimer);
    try {
      this.onerror?.({ message: err.message, error: err });
    } catch {
      /* ignore */
    }
    try {
      this.socket?.destroy();
    } catch {
      /* ignore */
    }
    this.#emitClose(1006, err.message);
  }

  #dial() {
    const target = new URL(this.url);
    const secure = target.protocol === 'wss:';
    const host = target.hostname;
    const port = target.port ? Number(target.port) : (secure ? 443 : 80);
    const defaultPort = secure ? 443 : 80;

    this.hostHeader = port === defaultPort ? host : `${host}:${port}`;

    const key = crypto.randomBytes(16).toString('base64');
    this.expectedAccept = acceptKeyFor(key);
    this.requestBytes = this.#buildRequest(key);

    let socket;
    try {
      socket = this.connectImpl({ host, port, servername: host, secure });
    } catch (err) {
      this.#fail(err);
      return;
    }
    this.socket = socket;

    this.handshakeTimer = setTimeout(() => {
      this.#fail(new Error(`handshake timed out after ${this.handshakeTimeoutMs}ms`));
    }, this.handshakeTimeoutMs);

    const sendRequest = () => {
      if (this.requestSent) return;
      this.requestSent = true;
      try {
        socket.write(this.requestBytes);
      } catch (err) {
        this.#fail(err);
      }
    };
    // A TLS socket must not be written to before the handshake completes.
    if (secure) socket.on('secureConnect', sendRequest);
    else socket.on('connect', sendRequest);

    socket.setNoDelay?.(true);
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', (err) => this.#fail(err));
    socket.on('end', () => this.#failRefusal());
    socket.on('close', () => {
      // A failed connect emits 'error' and then 'close'; report it once.
      if (this.readyState === 3) return;
      if (this.pendingRefusal) this.#failRefusal();
      else if (!this.handshakeDone) this.#fail(new Error('connection closed during handshake'));
      else this.#emitClose(1006, 'connection closed');
    });
  }

  #buildRequest(key) {
    const target = new URL(this.url);
    const path = `${target.pathname || '/'}${target.search || ''}`;
    const lines = [
      `GET ${path} HTTP/1.1`,
      `Host: ${this.hostHeader}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${key}`,
      ...Object.entries(this.extraHeaders).map(([name, value]) => `${name}: ${value}`),
    ];
    return `${lines.join('\r\n')}\r\n\r\n`;
  }

  #onData(chunk) {
    if (this.handshakeDone) {
      this.#handleFrames(chunk);
      return;
    }
    if (this.pendingRefusal) {
      this.refusalBody = Buffer.concat([this.refusalBody, chunk]).subarray(0, 2048);
      return;
    }
    this.#consumeHandshake(chunk);
  }

  #consumeHandshake(chunk) {
    this.headBuffer = this.headBuffer.length ? Buffer.concat([this.headBuffer, chunk]) : chunk;
    const end = this.headBuffer.indexOf('\r\n\r\n');
    if (end < 0) {
      if (this.headBuffer.length > 65536) this.#fail(new Error('handshake response headers are too large'));
      return;
    }

    const head = this.headBuffer.subarray(0, end).toString('utf8');
    const rest = this.headBuffer.subarray(end + 4);
    this.headBuffer = Buffer.alloc(0);

    const [statusLine, ...headerLines] = head.split('\r\n');
    const matched = /^HTTP\/1\.[01] (\d{3}) ?(.*)$/.exec(statusLine.trim());
    if (!matched) {
      this.#fail(new Error(`malformed handshake response: "${statusLine}"`));
      return;
    }
    const status = Number(matched[1]);
    const headers = {};
    for (const line of headerLines) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
    }

    if (status !== 101) {
      // Give the server a moment to send an explanatory body, then report it.
      this.pendingRefusal = { status, statusText: matched[2] };
      this.refusalBody = rest.subarray(0, 2048);
      this.refusalTimer = setTimeout(() => this.#failRefusal(), 300);
      this.refusalTimer.unref?.();
      return;
    }

    if (headers['sec-websocket-accept'] !== this.expectedAccept) {
      this.#fail(new Error(`bad Sec-WebSocket-Accept: got "${headers['sec-websocket-accept']}"`));
      this.socket?.destroy();
      return;
    }
    if ((headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      this.#fail(new Error(`bad Upgrade header: "${headers.upgrade}"`));
      this.socket?.destroy();
      return;
    }

    clearTimeout(this.handshakeTimer);
    this.handshakeDone = true;
    this.readyState = 1;
    try {
      this.onopen?.({});
    } catch {
      /* ignore */
    }
    if (rest.length) this.#handleFrames(rest);
  }

  #failRefusal() {
    if (!this.pendingRefusal || this.readyState === 3) return;
    const { status, statusText } = this.pendingRefusal;
    this.pendingRefusal = null;
    clearTimeout(this.refusalTimer);
    const body = this.refusalBody.toString('utf8').trim();
    this.#fail(new Error(
      `server refused the upgrade: HTTP ${status}${statusText ? ` ${statusText}` : ''}${body ? ` - ${body.slice(0, 200)}` : ''}`,
    ));
  }

  #handleFrames(chunk) {
    let frames;
    try {
      frames = this.parser.push(chunk);
    } catch (err) {
      this.#fail(err);
      return;
    }
    for (const frame of frames) {
      if (frame.payload.length > this.maxPayload) {
        this.#fail(new Error('payload exceeds limit'));
        return;
      }
      if (frame.opcode === OPCODE.PING) {
        this.#write(encodeFrame(OPCODE.PONG, frame.payload));
        continue;
      }
      if (frame.opcode === OPCODE.PONG) continue;
      if (frame.opcode === OPCODE.CLOSE) {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
        const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString('utf8') : '';
        try {
          this.socket?.end(encodeFrame(OPCODE.CLOSE, frame.payload.subarray(0, 2)));
        } catch {
          /* ignore */
        }
        this.#emitClose(code, reason);
        continue;
      }
      if (frame.opcode === OPCODE.TEXT || frame.opcode === OPCODE.BINARY) {
        try {
          this.onmessage?.({ data: frame.opcode === OPCODE.TEXT ? frame.payload.toString('utf8') : frame.payload });
        } catch (err) {
          this.#fail(err);
        }
      }
    }
  }

  #write(buffer) {
    if (!this.socket || this.readyState !== 1) return false;
    try {
      this.socket.write(buffer);
      return true;
    } catch (err) {
      this.#fail(err);
      return false;
    }
  }

  send(data) {
    return this.#write(encodeFrame(OPCODE.TEXT, Buffer.from(String(data), 'utf8')));
  }

  close(code = 1000, reason = '') {
    if (this.readyState !== 1) {
      this.readyState = 3;
      return;
    }
    this.readyState = 2;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason, 'utf8'));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2, 'utf8');
    this.#write(encodeFrame(OPCODE.CLOSE, payload));
    const socket = this.socket;
    setTimeout(() => {
      try {
        socket?.destroy();
      } catch {
        /* ignore */
      }
      this.#emitClose(code, reason);
    }, 100).unref?.();
  }
}
