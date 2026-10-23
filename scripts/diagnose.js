/**
 * Figures out why the long connection cannot be established.
 *
 * Node's built-in WebSocket collapsed every handshake failure into "network
 * error or non-101 status code", which hid the real cause. The bridge now
 * speaks RFC 6455 itself (src/ws-client.js), but the diagnostic is still
 * useful: it walks the stack one layer at a time - proxy env -> system proxy ->
 * DNS -> TCP -> TLS -> HTTP upgrade -> real subscribe.
 *
 * Run: npm run diagnose
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';

import { rawUpgrade, parseHead } from './lib/raw-upgrade.js';

import { loadConfig } from '../src/config.js';
import { LongConnClient } from '../src/longconn.js';
import { MiniWebSocket } from '../src/ws-client.js';

const config = loadConfig(process.env.BRIDGE_CONFIG, { requireWecom: false });
const wsUrl = config.wecom?.longconn?.wsUrl ?? 'wss://openws.work.weixin.qq.com';
const target = new URL(wsUrl);
const host = target.hostname;
const port = target.port ? Number(target.port) : 443;

const note = (text) => console.log(text);

/** Clash/Surge style fake-IP ranges and RFC1918 ranges mean traffic is intercepted. */
function classifyAddress(address) {
  if (address.includes(':')) return 'IPv6';
  const p = address.split('.').map(Number);
  if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return 'fake-IP（Clash/Surge TUN 接管）';
  if (p[0] === 127) return '本地回环（被本地代理接管）';
  if (p[0] === 10) return '内网地址（被代理接管）';
  if (p[0] === 192 && p[1] === 168) return '内网地址（被代理接管）';
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return '内网地址（被代理接管）';
  return '公网地址';
}

function withTimeout(promise, ms, label = '') {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms);
    }),
  ]);
}


console.log(`\n诊断目标 ${wsUrl}\n${'─'.repeat(64)}`);

note('\n[1] 代理环境变量');
const proxyVars = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']
  .filter((name) => process.env[name]);
note(proxyVars.length
  ? `  ⚠️  ${proxyVars.map((v) => `${v}=${process.env[v]}`).join('\n      ')}`
  : '  ✓ 未设置');

note('\n[2] macOS 系统代理');
try {
  const out = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 5000 });
  const enabled = /HTTP(S)?Enable\s*:\s*1/.test(out);
  const proxyHost = /HTTPSProxy\s*:\s*(\S+)/.exec(out)?.[1] ?? /HTTPProxy\s*:\s*(\S+)/.exec(out)?.[1];
  const proxyPort = /HTTPSPort\s*:\s*(\d+)/.exec(out)?.[1] ?? /HTTPPort\s*:\s*(\d+)/.exec(out)?.[1];
  note(enabled
    ? `  ⚠️  系统代理已开启${proxyHost ? ` → ${proxyHost}:${proxyPort ?? ''}` : ''}`
    : '  ✓ 系统代理未开启');
} catch {
  note('  （读取失败，跳过）');
}

note('\n[3] DNS 解析');
let suspicious = false;
try {
  const records = await withTimeout(dns.lookup(host, { all: true }), 8000, 'DNS ');
  for (const { address } of records) {
    const kind = classifyAddress(address);
    if (kind !== '公网地址' && kind !== 'IPv6') suspicious = true;
    note(`  ${kind === '公网地址' || kind === 'IPv6' ? ' ' : '⚠'} ${address.padEnd(42)} ${kind}`);
  }
  if (suspicious) note('  → 结论：DNS 被代理软件接管，流量会绕道国外，企微大概率拒绝。');
} catch (err) {
  note(`  ✗ 解析失败：${err.message}`);
  note('  → 结论：DNS 不通，先确认机器本身能上网。');
}

note('\n[4] TCP 连接 443');
const tcpOk = await withTimeout(new Promise((resolve) => {
  const socket = net.connect({ host, port });
  socket.setTimeout(8000);
  socket.on('connect', () => {
    note(`  ✓ 已连接（本地出口 ${socket.localAddress}）`);
    socket.destroy();
    resolve(true);
  });
  socket.on('timeout', () => {
    note('  ✗ 连接超时');
    socket.destroy();
    resolve(false);
  });
  socket.on('error', (err) => {
    note(`  ✗ ${err.message}`);
    resolve(false);
  });
}), 12000, 'TCP ').catch((err) => {
  note(`  ✗ ${err.message}`);
  return false;
});

if (tcpOk) {
  note('\n[5] TLS 握手');
  await withTimeout(new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: host }, () => {
      const cert = socket.getPeerCertificate();
      const issuer = `${cert.issuer?.O ?? ''} ${cert.issuer?.CN ?? ''}`.trim();
      note(`  ✓ TLS 已建立，协议 ${socket.getProtocol()}`);
      note(`    证书 CN : ${cert.subject?.CN ?? '(无)'}`);
      note(`    签发者  : ${issuer || '(无)'}`);
      if (!socket.authorized) note(`  ⚠️  证书校验未通过：${socket.authorizationError}`);
      if (/clash|surge|mitm|self|localhost|charles/i.test(issuer)) {
        note('  → 结论：证书像本地代理自签发的，TLS 被中间人劫持。');
      }
      socket.destroy();
      resolve();
    });
    socket.setTimeout(10000);
    socket.on('timeout', () => {
      note('  ✗ 握手超时');
      socket.destroy();
      resolve();
    });
    socket.on('error', (err) => {
      note(`  ✗ ${err.message}`);
      resolve();
    });
  }), 15000, 'TLS ').catch((err) => note(`  ✗ ${err.message}`));

  // Node's own HTTP client answers 404 to this handshake while the identical
  // bytes over a raw TLS socket get 101, so only the raw path is meaningful
  // here. That is also what src/ws-client.js does.
  note('\n[6] WebSocket 握手（原始 TLS，逐条变体）');
  const variants = [
    ['只有升级头（桥接实际发的内容）', {}],
    ['+ User-Agent: curl', { 'User-Agent': 'curl/8.7.1' }],
    ['+ Origin: https://work.weixin.qq.com', { origin: 'https://work.weixin.qq.com' }],
    ['+ User-Agent: aibot-node-sdk', { 'User-Agent': 'aibot-node-sdk' }],
  ];
  for (const [label, extraHeaders] of variants) {
    const result = await rawUpgrade({ host, port, path: target.pathname || '/', extraHeaders });
    if (!result.ok) {
      note(`\n  ── ${label}\n     ✗ ${result.error}`);
      continue;
    }
    const { status, statusText, headers } = parseHead(result.head);
    const suffix = headers['sec-websocket-accept'] ? `，Sec-WebSocket-Accept ${headers['sec-websocket-accept']}` : '';
    note(`\n  ── ${label}\n     HTTP ${status} ${statusText}${suffix}`);
  }

  // Isolates the transport from the credentials: this dials the socket exactly
  // the way `npm start` does, but never sends aibot_subscribe.
  note('\n[6c] 桥接实际使用的 WebSocket 客户端握手（不涉及凭据）');
  await withTimeout(new Promise((resolve) => {
    const ws = new MiniWebSocket(wsUrl);
    ws.onopen = () => {
      note('  ✓ 握手成功，socket 已打开（传输层没有问题）');
      ws.close();
      resolve();
    };
    ws.onerror = (event) => {
      note(`  ✗ ${event.message}`);
      resolve();
    };
    ws.onclose = () => resolve();
  }), 20000, 'WS ').catch((err) => note(`  ✗ ${err.message}`));
}


note('\n[7] 真实 WebSocket 订阅测试');
await withTimeout(new Promise((resolve) => {
  const client = new LongConnClient({
    botId: config.wecom?.longconn?.botId ?? 'test',
    secret: config.wecom?.longconn?.secret ?? 'test',
    wsUrl,
    logger: { log() {}, error() {} },
  });
  const done = (text) => {
    note(text);
    client.close();
    resolve();
  };
  client.on('ready', () => done('  ✓ 订阅成功，BotID 与 Secret 有效'));
  client.on('subscribeFailed', (res) => done(`  ✗ 订阅被拒：${res.errcode} ${res.errmsg}\n  → 结论：网络通了，但 BotID/Secret 不对。`));
  client.connect();
  setTimeout(() => done('  ✗ 12 秒内既未订阅成功也未被拒，仍卡在网络层'), 12000);
}), 16000, 'WebSocket ').catch((err) => note(`  ✗ ${err.message}`));

console.log(`\n${'─'.repeat(64)}`);
console.log('把以上全部内容贴回给我。\n');
process.exit(0);
