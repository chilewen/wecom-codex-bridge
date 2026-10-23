import crypto from 'node:crypto';

/**
 * WeCom (WeChat Work) callback message encryption, compatible with the official
 * WXBizMsgCrypt reference implementation.
 *
 *   key = Base64Decode(EncodingAESKey + "=")   // 32 bytes
 *   iv  = key[0..16]
 *   AES-256-CBC
 *
 * Plaintext layout:
 *   random(16) | msgLen(4, big endian) | msg | receiveId
 */

const BLOCK_SIZE = 32;

export function decodeAesKey(encodingAESKey) {
  if (typeof encodingAESKey !== 'string' || encodingAESKey.length !== 43) {
    throw new Error('EncodingAESKey must be exactly 43 characters');
  }
  const key = Buffer.from(`${encodingAESKey}=`, 'base64');
  if (key.length !== 32) {
    throw new Error(`EncodingAESKey decoded to ${key.length} bytes, expected 32`);
  }
  return key;
}

function pkcs7Pad(buf) {
  const pad = BLOCK_SIZE - (buf.length % BLOCK_SIZE) || BLOCK_SIZE;
  return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
}

function pkcs7Unpad(buf) {
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > BLOCK_SIZE) return buf;
  return buf.subarray(0, buf.length - pad);
}

export function sha1Signature(token, timestamp, nonce, encrypt) {
  const raw = [token, timestamp, nonce, encrypt].map(String).sort().join('');
  return crypto.createHash('sha1').update(raw, 'utf8').digest('hex');
}

export function verifySignature({ token, timestamp, nonce, encrypt, signature }) {
  const expected = sha1Signature(token, timestamp, nonce, encrypt);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature ?? ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function encryptMessage({ plaintext, encodingAESKey, receiveId = '' }) {
  const key = decodeAesKey(encodingAESKey);
  const iv = key.subarray(0, 16);
  const random = crypto.randomBytes(16);
  const msg = Buffer.from(plaintext, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(msg.length, 0);
  const body = pkcs7Pad(Buffer.concat([random, len, msg, Buffer.from(receiveId, 'utf8')]));

  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(body), cipher.final()]).toString('base64');
}

/**
 * @returns {{ message: string, receiveId: string }}
 */
export function decryptMessage({ encrypt, encodingAESKey }) {
  const key = decodeAesKey(encodingAESKey);
  const iv = key.subarray(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  const padded = Buffer.concat([
    decipher.update(Buffer.from(encrypt, 'base64')),
    decipher.final(),
  ]);
  const content = pkcs7Unpad(padded);
  if (content.length < 20) {
    throw new Error('Decrypted payload is too short');
  }
  const msgLen = content.readUInt32BE(16);
  if (20 + msgLen > content.length) {
    throw new Error('Declared message length exceeds decrypted payload');
  }
  return {
    message: content.subarray(20, 20 + msgLen).toString('utf8'),
    receiveId: content.subarray(20 + msgLen).toString('utf8'),
  };
}

/**
 * Full inbound verification + decryption for a callback request.
 * @returns {{ message: string, receiveId: string, raw: string }}
 */
export function unwrapCallback({ query, body, token, encodingAESKey, strictReceiveId, expectedReceiveId }) {
  const {
    msg_signature: signature,
    timestamp,
    nonce,
    encrypt,
  } = query;

  if (!signature || !timestamp || !nonce) {
    throw Object.assign(new Error('Missing signature/timestamp/nonce in query string'), { status: 400 });
  }
  if (!encrypt) {
    throw Object.assign(new Error('Missing encrypt parameter'), { status: 400 });
  }
  if (!verifySignature({ token, timestamp, nonce, encrypt, signature })) {
    throw Object.assign(new Error('Signature mismatch'), { status: 401 });
  }

  const { message, receiveId } = decryptMessage({ encrypt, encodingAESKey });
  if (strictReceiveId && expectedReceiveId && receiveId !== expectedReceiveId) {
    throw Object.assign(
      new Error(`receiveId mismatch: got "${receiveId}", expected "${expectedReceiveId}"`),
      { status: 401 },
    );
  }
  // `body` is only used for callers that want the raw XML; decrypted XML wins.
  void body;
  return { message, receiveId, raw: message };
}
