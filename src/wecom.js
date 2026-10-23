/**
 * Inbound XML parsing + outbound message delivery for WeCom.
 */

/**
 * Minimal XML field extractor. WeCom callback bodies are a flat <xml> element
 * with CDATA text values, so a targeted extractor is enough and avoids a
 * dependency on a full XML parser.
 *
 * Only leaf elements are matched: a container like `<xml>...</xml>` holds child
 * tags, so it is deliberately skipped instead of swallowing the whole document.
 */
const LEAF_ELEMENT = /<([A-Za-z_][\w.:-]*)>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*<\/\1>/g;

export function parseXml(xml) {
  const out = {};
  LEAF_ELEMENT.lastIndex = 0;
  let match;
  while ((match = LEAF_ELEMENT.exec(xml)) !== null) {
    out[match[1]] = match[2] ?? match[3] ?? '';
  }
  return out;
}

/**
 * Callback-mode equivalent of the long-connection extractor. WeCom puts the
 * transcript of a voice message in `Recognition`; `Content` is accepted as a
 * fallback in case the callback shape changes.
 */
export function extractCallbackText(message = {}) {
  if (message.MsgType === 'text') return String(message.Content ?? '').trim();
  if (message.MsgType !== 'voice') return '';
  for (const field of ['Recognition', 'VoiceText', 'Content']) {
    const value = message[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * WeCom text messages cap at 2048 bytes; markdown at 4096. Split on character
 * boundaries so multi-byte characters are never cut in half.
 */
export function chunkText(text, maxBytes = 1800) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').trim() || '(空回复)';
  const chunks = [];
  let current = '';
  let currentBytes = 0;

  for (const char of normalized) {
    const size = Buffer.byteLength(char, 'utf8');
    if (currentBytes + size > maxBytes && current) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += size;
  }
  if (current) chunks.push(current);
  return chunks;
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { errcode: -1, errmsg: text };
  }
  return json;
}

export async function sendViaWebhook(webhookUrl, text) {
  const result = await postJson(webhookUrl, { msgtype: 'text', text: { content: text } });
  if (result.errcode !== 0) {
    throw new Error(`webhook send failed: ${result.errcode} ${result.errmsg}`);
  }
  return result;
}

export class AppMessenger {
  constructor({ corpId, corpSecret, agentId }) {
    this.corpId = corpId;
    this.corpSecret = corpSecret;
    this.agentId = agentId;
    this.token = null;
    this.expiresAt = 0;
  }

  async getToken() {
    if (this.token && Date.now() < this.expiresAt) return this.token;
    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(this.corpId)}&corpsecret=${encodeURIComponent(this.corpSecret)}`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.errcode !== 0) {
      throw new Error(`gettoken failed: ${json.errcode} ${json.errmsg}`);
    }
    this.token = json.access_token;
    // Refresh a minute early to avoid edge-of-expiry failures.
    this.expiresAt = Date.now() + (Number(json.expires_in ?? 7200) - 60) * 1000;
    return this.token;
  }

  async sendToUser(userId, text) {
    const token = await this.getToken();
    const result = await postJson(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, {
      touser: userId,
      msgtype: 'text',
      agentid: Number(this.agentId) || this.agentId,
      text: { content: text },
      safe: 0,
    });
    if (result.errcode !== 0) {
      throw new Error(`app send failed: ${result.errcode} ${result.errmsg}`);
    }
    return result;
  }
}

/**
 * Delivers a message according to wecom.replyMode, chunking long output.
 * Resolves to the number of chunks that were delivered successfully.
 */
export async function deliver({ config, messenger, userId, text }) {
  const chunks = chunkText(text);
  let delivered = 0;

  for (const chunk of chunks) {
    const mode = config.wecom.replyMode;
    let ok = false;
    const errors = [];

    if ((mode === 'webhook' || mode === 'both') && config.wecom.webhookUrl) {
      try {
        await sendViaWebhook(config.wecom.webhookUrl, chunk);
        ok = true;
      } catch (err) {
        errors.push(err.message);
      }
    }

    if (!ok && (mode === 'app' || mode === 'both') && messenger) {
      try {
        await messenger.sendToUser(userId, chunk);
        ok = true;
      } catch (err) {
        errors.push(err.message);
      }
    }

    if (!ok) {
      console.error(`[wecom] delivery failed for ${userId}: ${errors.join(' | ')}`);
      break;
    }
    delivered += 1;
  }

  return delivered;
}
