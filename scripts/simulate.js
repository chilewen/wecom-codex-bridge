/**
 * End-to-end check of the callback path without the real WeCom service and
 * without binding a port: builds a throwaway config, drives the real request
 * handler with mock req/res objects, performs the GET url-verification
 * handshake, then POSTs encrypted messages and inspects the pushed replies.
 *
 * Run: npm run simulate
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { encryptMessage, sha1Signature } from '../src/wecom-crypto.js';
import { DEFAULTS, mergeConfig } from '../src/config.js';
import { StateStore } from '../src/sessions.js';
import { Bridge } from '../src/bot.js';
import { createRequestHandler } from '../src/app.js';

const TOKEN = 'simulate-token';
const AES_KEY = crypto.randomBytes(32).toString('base64').replace(/=+$/, '');
const CORP_ID = 'ww0000000000000000';

function mockReq(method, url, body = '') {
  const req = new Readable({ read() {} });
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost' };
  process.nextTick(() => {
    if (body) req.push(body);
    req.push(null);
  });
  return req;
}

function mockRes() {
  return {
    statusCode: 0,
    headersSent: false,
    body: '',
    writeHead(status) {
      this.statusCode = status;
      this.headersSent = true;
    },
    end(body) {
      this.body = body ?? '';
    },
  };
}

async function call(handler, method, url, body) {
  const res = mockRes();
  await handler(mockReq(method, url, body), res);
  return res;
}

function makeHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-sim-'));
  const projects = ['alpha-api', 'beta-web', 'gamma-app'].map((name) => {
    const p = path.join(dir, name);
    fs.mkdirSync(path.join(p, '.git'), { recursive: true });
    return { name, path: p };
  });

  const config = mergeConfig(DEFAULTS, {
    wecom: { token: TOKEN, encodingAESKey: AES_KEY, corpId: CORP_ID, replyMode: 'webhook' },
    projects: { roots: [], list: projects, scanDepth: 1 },
    codex: { scratchDir: path.join(dir, 'scratch') },
    stateFile: path.join(dir, 'state.json'),
  });

  const pushed = [];
  const transport = {
    async send(ctx, text) {
      pushed.push({ userId: ctx?.userId, text });
      return 1;
    },
    openStream(ctx) {
      let buffer = '';
      return {
        async push(delta) {
          if (!delta) return;
          buffer += delta;
          pushed.push({ userId: ctx?.userId, text: buffer, streaming: true });
        },
        async finish(text) {
          pushed.push({ userId: ctx?.userId, text: text ?? buffer });
        },
      };
    },
  };
  const logger = { log() {}, error() {} };
  const store = new StateStore(config.stateFile);
  const bridge = new Bridge({ config, store, projects, transport, logger });
  const handler = createRequestHandler({ config, bridge, projects, logger });

  return { config, dir, projects, pushed, bridge, handler, store };
}

async function waitForText(pushed, needle, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pushed.some((entry) => String(entry.text).includes(needle))) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

async function waitForPushes(pushed, count, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (pushed.length < count && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

function encryptedEnvelope(innerXml) {
  const encrypt = encryptMessage({ plaintext: innerXml, encodingAESKey: AES_KEY, receiveId: CORP_ID });
  const envelope = `<xml><ToUserName><![CDATA[${CORP_ID}]]></ToUserName>`
    + `<Encrypt><![CDATA[${encrypt}]]></Encrypt><AgentID><![CDATA[1]]></AgentID></xml>`;
  return { encrypt, envelope };
}

function signedQuery(encrypt, nonce) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const msg_signature = sha1Signature(TOKEN, timestamp, nonce, encrypt);
  return `msg_signature=${msg_signature}&timestamp=${timestamp}&nonce=${nonce}`;
}

function textMessage(userId, content, msgId) {
  return `<xml><ToUserName><![CDATA[${CORP_ID}]]></ToUserName>`
    + `<FromUserName><![CDATA[${userId}]]></FromUserName>`
    + '<CreateTime>1700000000</CreateTime>'
    + '<MsgType><![CDATA[text]]></MsgType>'
    + `<Content><![CDATA[${content}]]></Content>`
    + `<MsgId>${msgId}</MsgId><AgentID>1</AgentID></xml>`;
}

async function postInner(handler, inner, nonce) {
  const { encrypt, envelope } = encryptedEnvelope(inner);
  return call(handler, 'POST', `/wecom/callback?${signedQuery(encrypt, String(nonce))}`, envelope);
}

const postText = (handler, userId, content, msgId) =>
  postInner(handler, textMessage(userId, content, msgId), msgId);

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push([name, true]);
  } catch (err) {
    results.push([name, false, err.message]);
  }
}

const h = makeHarness();
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

await test('GET url verification returns the decrypted echostr', async () => {
  const plain = crypto.randomBytes(16).toString('hex');
  const echostr = encryptMessage({ plaintext: plain, encodingAESKey: AES_KEY, receiveId: CORP_ID });
  const res = await call(h.handler, 'GET', `/wecom/callback?${signedQuery(echostr, 'v1')}&echostr=${encodeURIComponent(echostr)}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, plain);
});

await test('GET verification with a tampered signature is rejected', async () => {
  const echostr = encryptMessage({ plaintext: 'x', encodingAESKey: AES_KEY, receiveId: CORP_ID });
  const res = await call(h.handler, 'GET', `/wecom/callback?msg_signature=deadbeef&timestamp=1&nonce=2&echostr=${encodeURIComponent(echostr)}`);
  assert.equal(res.statusCode, 401);
});

await test('POST answers 200 immediately and pushes replies asynchronously', async () => {
  const res = await postText(h.handler, 'zhangsan', '/projects', 101);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, '', 'callback response must stay empty; replies are pushed');
  await waitForPushes(h.pushed, 1);
});

await test('/projects lists every configured project', async () => {
  const text = h.pushed.at(-1).text;
  for (const name of ['alpha-api', 'beta-web', 'gamma-app']) assert.ok(text.includes(name), `missing ${name}`);
});

await test('/use 2 switches the user to the second project', async () => {
  await postText(h.handler, 'zhangsan', '/use 2', 102);
  await waitForPushes(h.pushed, 2);
  assert.ok(h.pushed.at(-1).text.includes('beta-web'), h.pushed.at(-1).text);
});

await test('the project choice is persisted per user', async () => {
  assert.ok(h.store.getUser('zhangsan').project.endsWith('beta-web'));
});

await test('/p reports the selected project', async () => {
  await postText(h.handler, 'zhangsan', '/p', 103);
  await waitForPushes(h.pushed, 3);
  assert.ok(h.pushed.at(-1).text.includes('beta-web'));
});

await test('/use starts a fresh conversation session', async () => {
  h.store.update('zhangsan', { sessionId: 'stale-session' });
  await postText(h.handler, 'zhangsan', '/use 1', 104);
  await waitForPushes(h.pushed, 4);
  assert.equal(h.store.getUser('zhangsan').sessionId, null);
});

await test('a user without a project is asked to choose one', async () => {
  const before = h.pushed.length;
  await postText(h.handler, 'lisi', '帮我看看这个 bug', 105);
  await waitForPushes(h.pushed, before + 1);
  assert.equal(h.pushed.at(-1).userId, 'lisi');
  assert.ok(h.pushed.at(-1).text.includes('请先选择工作目录'), h.pushed.at(-1).text);
});

await test('/none switches a user to 无项目 mode without touching any repo', async () => {
  const before = h.pushed.length;
  await postText(h.handler, 'wangwu', '/none', 106);
  await waitForPushes(h.pushed, before + 1);
  const reply = h.pushed.at(-1).text;
  assert.ok(reply.includes('无项目'), reply);

  const user = h.store.getUser('wangwu');
  assert.equal(user.scratch, true);
  assert.equal(user.project, null);
  assert.equal(user.sessionId, null, 'switching workspace must drop the old context');

  const workspace = h.bridge.resolveWorkspace('wangwu');
  assert.equal(workspace.kind, 'scratch');
  assert.equal(workspace.label, '无项目');
  assert.equal(workspace.cwd, h.config.codex.scratchDir);
});

await test('/p reports 无项目 mode and the scratch directory', async () => {
  const before = h.pushed.length;
  await postText(h.handler, 'wangwu', '/p', 107);
  await waitForPushes(h.pushed, before + 1);
  const text = h.pushed.at(-1).text;
  assert.ok(text.includes('无项目'), text);
  assert.ok(text.includes(h.config.codex.scratchDir), text);
});

await test('/use leaves 无项目 mode', async () => {
  const before = h.pushed.length;
  await postText(h.handler, 'wangwu', '/use 1', 108);
  await waitForPushes(h.pushed, before + 1);
  assert.equal(h.store.getUser('wangwu').scratch, false);
  assert.equal(h.bridge.resolveWorkspace('wangwu').kind, 'project');
});

await test('an unwritable scratch dir is reported instead of crashing the run', async () => {
  h.store.update('wangwu', { scratch: true, project: null });
  const before = h.pushed.length;
  // Point the scratch dir at a path that cannot be created (a file, not a dir).
  const blocker = path.join(h.config.codex.scratchDir, 'blocker');
  fs.mkdirSync(path.dirname(blocker), { recursive: true });
  fs.writeFileSync(blocker, 'not a directory');
  h.config.codex.scratchDir = path.join(blocker, 'nested');

  await postText(h.handler, 'wangwu', '帮我跑一下', 109);
  await waitForPushes(h.pushed, before + 1);
  await tick();
  assert.ok(h.pushed.at(-1).text.includes('无法创建工作目录'), h.pushed.at(-1).text);

  h.config.codex.scratchDir = path.dirname(blocker);
  h.store.update('wangwu', { scratch: false, project: h.projects[0].path });
});

await test('codex.showAck=false drops the 已收到 line but still reports failures', async () => {
  const before = h.pushed.length;
  h.config.codex.showAck = false;
  h.config.codex.bin = '/nonexistent/codex-for-test';
  h.store.update('wangwu', { scratch: true, project: null, sessionId: null });

  await postText(h.handler, 'wangwu', '随便问一句', 110);
  await waitForPushes(h.pushed, before + 1);
  await tick();

  const fresh = h.pushed.slice(before).map((entry) => String(entry.text));
  assert.ok(!fresh.some((text) => text.includes('已收到')), `no ack expected, got ${JSON.stringify(fresh)}`);
  assert.ok(fresh.some((text) => text.includes('执行失败')), `the failure must still surface, got ${JSON.stringify(fresh)}`);

  h.config.codex.bin = 'codex';
  h.config.codex.showAck = true;
  h.store.update('wangwu', { scratch: false, project: h.projects[0].path });
});

await test('a successful run: ack → keepalive → result, all in one message', async () => {
  // A stand-in for the Codex CLI so the whole turn can run end to end here.
  const bin = path.join(h.dir, 'fake-codex');
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    'sleep 0.5',
    'echo \'{"type":"session_configured","session_id":"fake-session-abc"}\'',
    'echo \'{"type":"item.completed","item":{"type":"command_execution","command":"rg foo src/"}}\'',
    'echo \'{"type":"item.completed","item":{"type":"agent_message","text":"这是最终结果"}}\'',
    '',
  ].join('\n'), { mode: 0o755 });

  h.config.codex.showAck = true;
  h.config.codex.keepaliveMs = 120;
  h.config.codex.streamProgress = false;
  h.config.codex.bin = bin;
  h.store.update('wenzhili', { scratch: true, project: null, sessionId: null });

  const before = h.pushed.length;
  await postText(h.handler, 'wenzhili', '帮我分析一下福赛科技', 111);
  assert.ok(await waitForText(h.pushed, '这是最终结果'), 'the run should finish');

  const fresh = h.pushed.slice(before).map((entry) => String(entry.text));
  assert.ok(fresh.some((text) => text.includes('已收到')), 'an ack should be pushed');
  assert.ok(fresh.some((text) => text.includes('正在处理…')), 'a keepalive line should be pushed');
  assert.ok(
    !fresh.some((text) => text.includes('$ rg foo')),
    'with streamProgress off, no command line may leak into the chat',
  );

  const last = fresh.at(-1);
  assert.ok(last.includes('这是最终结果'), last);
  assert.ok(last.includes('无项目'), `footer should name the workspace: ${last}`);
  assert.ok(!last.includes('正在处理…'), 'the result replaces the keepalive line');
  assert.ok(!last.includes('已收到'), 'the result replaces the ack line');
  assert.equal(h.store.getUser('wenzhili').sessionId, 'fake-session-abc');

  h.config.codex.bin = 'codex';
  h.config.codex.keepaliveMs = 0;
  h.store.update('wenzhili', { scratch: false, project: h.projects[0].path });
});

await test('a repeated MsgId is processed only once', async () => {
  const before = h.pushed.length;
  await postText(h.handler, 'zhangsan', '/help', 900);
  await waitForPushes(h.pushed, before + 1);
  await postText(h.handler, 'zhangsan', '/help', 900);
  await tick();
  assert.equal(h.pushed.length, before + 1);
});

await test('non-text messages get a friendly notice', async () => {
  const before = h.pushed.length;
  const inner = '<xml><FromUserName><![CDATA[wangwu]]></FromUserName><MsgType><![CDATA[image]]></MsgType><MsgId>201</MsgId></xml>';
  await postInner(h.handler, inner, 201);
  await waitForPushes(h.pushed, before + 1);
  assert.ok(h.pushed.at(-1).text.includes('只支持文字消息'));
});

await test('event messages are silently ignored', async () => {
  const before = h.pushed.length;
  const inner = '<xml><FromUserName><![CDATA[wangwu]]></FromUserName><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[enter_chat]]></Event><MsgId>202</MsgId></xml>';
  await postInner(h.handler, inner, 202);
  await tick();
  assert.equal(h.pushed.length, before);
});

await test('POST with a tampered signature is rejected and pushes nothing', async () => {
  const before = h.pushed.length;
  const { envelope } = encryptedEnvelope(textMessage('mallory', '/help', 300));
  const res = await call(h.handler, 'POST', '/wecom/callback?msg_signature=deadbeef&timestamp=1&nonce=2', envelope);
  assert.equal(res.statusCode, 401);
  await tick(100);
  assert.equal(h.pushed.length, before);
});

await test('POST without an Encrypt node is rejected', async () => {
  const res = await call(h.handler, 'POST', `/wecom/callback?${signedQuery('x', 'n')}`, '<xml><ToUserName><![CDATA[a]]></ToUserName></xml>');
  assert.equal(res.statusCode, 400);
});

await test('unknown paths 404 and /health reports status', async () => {
  assert.equal((await call(h.handler, 'GET', '/nope')).statusCode, 404);
  const health = await call(h.handler, 'GET', '/health');
  assert.equal(health.statusCode, 200);
  assert.equal(JSON.parse(health.body).ok, true);
});

await test('unsupported HTTP methods return 405', async () => {
  assert.equal((await call(h.handler, 'DELETE', '/wecom/callback')).statusCode, 405);
});

await test('security.allowedUsers blocks users that are not listed', async () => {
  const h2 = makeHarness();
  h2.config.security.allowedUsers = ['zhangsan'];
  await postText(h2.handler, 'stranger', '/help', 401);
  await waitForPushes(h2.pushed, 1);
  assert.ok(h2.pushed.at(-1).text.includes('没有使用权限'));
});

let failed = 0;
console.log('\nEnd-to-end simulation (callback path, no sockets)\n');
for (const [name, ok, detail] of results) {
  if (!ok) failed += 1;
  console.log(`  ${ok ? '\u2713' : '\u2717'} ${name}`);
  if (!ok) console.log(`      ${detail}`);
}
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
