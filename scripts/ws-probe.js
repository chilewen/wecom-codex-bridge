/**
 * Pinpoints why the WebSocket upgrade is refused.
 *
 * The diagnose step showed the server answering `404 Not Found` to a request
 * whose bytes are byte-for-byte equivalent to the curl command that got `101`.
 * This probe goes below Node's HTTP client: it opens a raw TLS socket and
 * writes request bytes by hand, then removes curl's headers one at a time to
 * find the one the server actually cares about.
 *
 * Run: npm run probe
 */
import crypto from 'node:crypto';
import https from 'node:https';
import { execFileSync } from 'node:child_process';

import { rawUpgrade, parseHead } from './lib/raw-upgrade.js';

import { loadConfig } from '../src/config.js';
import { MiniWebSocket } from '../src/ws-client.js';

const config = loadConfig(process.env.BRIDGE_CONFIG, { requireWecom: false });
const wsUrl = config.wecom?.longconn?.wsUrl ?? 'wss://openws.work.weixin.qq.com';
const target = new URL(wsUrl);
const host = target.hostname;
const port = target.port ? Number(target.port) : 443;
const path = target.pathname || '/';
const CURL_UA = 'curl/8.7.1';

/** Reads a raw-TLS result into a printable one-liner. */
async function rawCase(options) {
  const result = await rawUpgrade({ host, port, path, ...options });
  if (!result.ok) return `✗ ${result.error}`;
  const { status, statusText, headers } = parseHead(result.head);
  const detail = headers['sec-websocket-accept'] ? `\n    Sec-WebSocket-Accept: ${headers['sec-websocket-accept']}` : '';
  return `HTTP ${status} ${statusText}${detail}`;
}

/** The same request, but through Node's HTTP client (what diagnose used). */
function nodeHttpUpgrade({ extraHeaders = {}, timeoutMs = 12000 } = {}) {
  return new Promise((resolve) => {
    const req = https.request({
      host,
      port,
      path,
      method: 'GET',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': crypto.randomBytes(16).toString('base64'),
        ...extraHeaders,
      },
    });
    let settled = false;
    const finish = (text) => {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve(text);
    };
    req.on('upgrade', (res) => finish(`✓ 101 Switching Protocols\n${res.headers.upgrade ? `    upgrade: ${res.headers.upgrade}` : ''}`.trimEnd()));
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c) => { body += c.toString('utf8'); });
      res.on('end', () => finish(`HTTP ${res.statusCode} ${res.statusMessage ?? ''}${body.trim() ? `\n    body: ${body.trim().slice(0, 200)}` : ''}`));
      res.on('error', () => finish(`HTTP ${res.statusCode}（读取响应失败）`));
    });
    req.on('error', (err) => finish(`✗ ${err.message}`));
    req.setTimeout(timeoutMs, () => finish(`✗ ${timeoutMs}ms 内没有任何回应`));
    req.end();
  });
}

function miniWebSocketUpgrade(timeoutMs = 12000) {
  return new Promise((resolve) => {
    const ws = new MiniWebSocket(wsUrl);
    const timer = setTimeout(() => resolve(`✗ ${timeoutMs}ms 内既没打开也没报错`), timeoutMs);
    ws.onopen = () => { clearTimeout(timer); ws.close(); resolve('✓ 101 握手成功，socket 已打开'); };
    ws.onerror = (event) => { clearTimeout(timer); resolve(`✗ ${event.message}`); };
  });
}

const curlLike = { 'User-Agent': CURL_UA, Accept: '*/*' };

/**
 * The control: whatever curl does right now, on this machine, at this moment.
 * If curl still gets 101 while every request we build gets 404, the difference
 * is not the request bytes.
 */
function curlControl() {
  try {
    const out = execFileSync('curl', [
      '-s', '-i', '-N', '--max-time', '8',
      '-H', 'Connection: Upgrade',
      '-H', 'Upgrade: websocket',
      '-H', 'Sec-WebSocket-Version: 13',
      '-H', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      wsUrl,
    ], { encoding: 'utf8', timeout: 12000, stdio: ['ignore', 'pipe', 'pipe'] });
    return out.trim() || '（curl 没有任何输出）';
  } catch (err) {
    const partial = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
    return partial || `✗ curl 调用失败：${err.message}`;
  }
}

const cases = [
  ['对照：curl 原生（就是拿到 101 的那条命令）', () => curlControl()],
  ['原始 TLS · 完全照抄 curl（User-Agent + Accept）', () => rawCase({ extraHeaders: curlLike })],
  ['原始 TLS · 去掉 User-Agent', () => rawCase({ extraHeaders: { Accept: '*/*' } })],
  ['原始 TLS · 去掉 Accept', () => rawCase({ extraHeaders: { 'User-Agent': CURL_UA } })],
  ['原始 TLS · 只有升级头（桥接实际发的内容）', () => rawCase()],
  ['Node https 客户端 · 照抄 curl', () => nodeHttpUpgrade({ extraHeaders: curlLike })],
  ['Node https 客户端 · 只有升级头', () => nodeHttpUpgrade()],
  ['MiniWebSocket（npm start 实际用的）', () => miniWebSocketUpgrade()],
];

console.log(`\nWebSocket 握手探针\n目标 ${wsUrl}\n${'─'.repeat(64)}`);
for (const [label, run] of cases) {
  console.log(`\n── ${label}`);
  const text = await Promise.resolve().then(run).catch((err) => `✗ ${err.message}`);
  for (const line of String(text).split('\n')) console.log(`   ${line}`);
}

console.log(`\n${'─'.repeat(64)}`);
console.log('读法：');
console.log('  · 原始 TLS = 101 且 MiniWebSocket = 101 → 传输层正常，可以 npm start。');
console.log('  · 原始 TLS = 101、Node https 客户端 = 404 → 这就是老问题：服务端不接受');
console.log('    Node HTTP 客户端发来的握手。桥接已不再走它（见 src/ws-client.js 顶部的说明）。');
console.log('  · 原始 TLS 也失败 → 服务端行为变了，先跑 npm run diagnose 看前面几层。');
console.log('\n把以上全部内容贴回给我。\n');
