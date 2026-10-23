/**
 * End-to-end check of the long-connection path using a fake WebSocket, so the
 * whole protocol flow is exercised without network or a real bot.
 *
 * Covers the wire format from developer.work.weixin.qq.com/document/path/101463.
 *
 * Run: npm run simulate:longconn
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LongConnClient, stripMention } from '../src/longconn.js';
import { createLongConnTransport } from '../src/transport.js';
import { attachLongConnBot } from '../src/longconn-bot.js';
import { DEFAULTS, mergeConfig } from '../src/config.js';
import { StateStore } from '../src/sessions.js';
import { Bridge } from '../src/bot.js';

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.autoReply = true;
    this.closed = false;
  }

  send(raw) {
    const frame = JSON.parse(raw);
    this.sent.push(frame);
    if (this.autoReply) {
      // Every command gets an ok response, like the real server.
      queueMicrotask(() => this.receive({ headers: { req_id: frame.headers?.req_id }, errcode: 0, errmsg: 'ok' }));
    }
  }

  close() {
    this.closed = true;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code: 1000, reason: 'closed' }));
  }

  // --- test helpers ---
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(obj) {
    this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) });
  }

  sentCmds() {
    return this.sent.map((f) => f.cmd);
  }

  lastOf(cmd) {
    return [...this.sent].reverse().find((f) => f.cmd === cmd);
  }

  reset() {
    this.sent = [];
  }
}

const results = [];
async function test(name, fn) {
  try {
    await withTimeout(fn(), 8000, name);
    results.push([name, true]);
  } catch (err) {
    results.push([name, false, err.message]);
  }
}

/** Keeps the event loop alive so a hung await fails loudly instead of exiting 13. */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
    }),
  ]);
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

// Errors are recorded so tests can assert on what the client complained about.
const loggedErrors = [];
const logger = { log() {}, error: (msg) => loggedErrors.push(String(msg)) };

function makeHarness({ heartbeatMs = 30, pongTimeoutMs = 20000, reconnectMinMs = 1000, reconnectMaxMs = 60000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'longconn-sim-'));
  const projects = ['alpha-api', 'beta-web'].map((name) => {
    const p = path.join(dir, name);
    fs.mkdirSync(path.join(p, '.git'), { recursive: true });
    return { name, path: p };
  });
  const config = mergeConfig(DEFAULTS, {
    wecom: { mode: 'longconn', longconn: { botId: 'BOTID123', secret: 'SECRET456', heartbeatMs } },
    projects: { roots: [], list: projects, scanDepth: 1 },
    stateFile: path.join(dir, 'state.json'),
  });

  // Each harness owns its sockets so tests cannot observe each other's client.
  const sockets = [];
  const client = new LongConnClient({
    botId: config.wecom.longconn.botId,
    secret: config.wecom.longconn.secret,
    heartbeatMs,
    pongTimeoutMs,
    reconnectMinMs,
    reconnectMaxMs,
    wsFactory: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    logger,
  });
  const transport = createLongConnTransport({ client, logger, streamThrottleMs: 0 });
  const store = new StateStore(config.stateFile);
  const bridge = new Bridge({ config, store, projects, transport, logger });

  attachLongConnBot({ client, bridge, transport, logger });

  return {
    config, client, transport, store, bridge, projects, sockets,
    socket: () => sockets.at(-1),
    errors: loggedErrors,
  };
}

function msgCallback({ reqId = 'REQ1', msgid = 'MSG1', userId = 'zhangsan', content = '/help', chattype = 'single', chatid } = {}) {
  return {
    cmd: 'aibot_msg_callback',
    headers: { req_id: reqId },
    body: {
      msgid,
      aibotid: 'BOTID123',
      ...(chatid ? { chatid } : {}),
      chattype,
      from: { userid: userId },
      msgtype: 'text',
      text: { content },
    },
  };
}

const h = makeHarness();

await test('dials the documented wss endpoint', async () => {
  h.client.connect();
  assert.ok(h.socket(), 'a socket should have been created');
  assert.equal(h.socket().url, 'wss://openws.work.weixin.qq.com');
});

await test('sends aibot_subscribe with bot_id and secret on open', async () => {
  h.socket().open();
  await waitFor(() => h.socket().lastOf('aibot_subscribe'));
  const frame = h.socket().lastOf('aibot_subscribe');
  assert.equal(frame.body.bot_id, 'BOTID123');
  assert.equal(frame.body.secret, 'SECRET456');
  assert.ok(frame.headers.req_id, 'req_id is required');
});

await test('becomes ready only after errcode 0', async () => {
  await waitFor(() => h.client.isReady);
  assert.equal(h.client.isReady, true);
  assert.equal(h.client.state, 'ready');
});

await test('rejects a bad secret without pretending to be ready', async () => {
  const bad = makeHarness();
  bad.client.connect();
  // Take over the reply so the subscribe answer under test is the error one.
  bad.socket().autoReply = false;
  bad.socket().open();
  await waitFor(() => bad.socket().lastOf('aibot_subscribe'));
  const sub = bad.socket().lastOf('aibot_subscribe');
  bad.socket().receive({ headers: { req_id: sub.headers.req_id }, errcode: 40001, errmsg: 'invalid secret' });
  await new Promise((r) => setTimeout(r, 150));
  assert.notEqual(bad.client.state, 'ready');
  bad.client.close();
});

await test('sends a ping heartbeat', async () => {
  await waitFor(() => h.socket().sentCmds().includes('ping'), 1500);
  assert.ok(h.socket().sentCmds().includes('ping'));
});

await test('an answered ping must NOT trigger a heartbeat timeout', async () => {
  // Regression: the pong reply is matched by req_id and consumed by the pending
  // matcher, so the heartbeat timer used to stay armed and fire anyway - the
  // connection then reconnected every pongTimeoutMs, forever.
  // heartbeatMs must exceed pongTimeoutMs (30s vs 20s in production), otherwise
  // each new ping re-arms the timer and hides the bug entirely.
  const hb = makeHarness({ heartbeatMs: 80, pongTimeoutMs: 30 });
  hb.client.connect();
  hb.socket().open();
  await waitFor(() => hb.client.isReady);

  hb.errors.length = 0;
  hb.socket().reset();
  await new Promise((r) => setTimeout(r, 400)); // ~5 heartbeat cycles

  const pings = hb.socket().sentCmds().filter((c) => c === 'ping').length;
  assert.ok(pings >= 4, `expected several pings, saw ${pings}`);
  const timeouts = hb.errors.filter((m) => m.includes('heartbeat timed out'));
  assert.deepEqual(timeouts, [], `a healthy link must not time out: ${timeouts.join(' | ')}`);
  assert.equal(hb.socket().closed, false, 'the socket must not be torn down');
  assert.equal(hb.client.isReady, true);
  hb.client.close();
});

await test('an unanswered ping does reconnect', async () => {
  const hb = makeHarness({ heartbeatMs: 80, pongTimeoutMs: 30 });
  hb.client.connect();
  const socket = hb.socket();
  socket.open();
  await waitFor(() => hb.client.isReady);

  // Stop answering pings (subscribe still works).
  socket.send = (raw) => {
    const frame = JSON.parse(raw);
    socket.sent.push(frame);
    if (frame.cmd !== 'ping') {
      queueMicrotask(() => socket.receive({ headers: { req_id: frame.headers.req_id }, errcode: 0 }));
    }
  };

  hb.errors.length = 0;
  await waitFor(() => hb.errors.some((m) => m.includes('heartbeat timed out')), 2000);
  assert.ok(
    hb.errors.some((m) => m.includes('heartbeat timed out')),
    'a silent server must be treated as a dead link',
  );
  hb.client.close();
});

await test('a command reply is sent as aibot_respond_msg echoing the callback req_id', async () => {
  const socket = h.socket();
  socket.reset();
  socket.receive(msgCallback({ reqId: 'REQ-HELP', content: '/help' }));
  await waitFor(() => socket.lastOf('aibot_respond_msg'));
  const frame = socket.lastOf('aibot_respond_msg');
  assert.equal(frame.headers.req_id, 'REQ-HELP', 'req_id must be passed through, per the doc');
  assert.equal(frame.body.msgtype, 'markdown');
  assert.ok(frame.body.markdown.content.includes('/projects'), frame.body.markdown.content);
});

await test('project commands work over the long connection', async () => {
  const socket = h.socket();
  socket.reset();
  socket.receive(msgCallback({ reqId: 'REQ-USE', msgid: 'MSG2', content: '/use 2' }));
  await waitFor(() => socket.lastOf('aibot_respond_msg'));
  assert.ok(socket.lastOf('aibot_respond_msg').body.markdown.content.includes('beta-web'));
  assert.ok(h.store.getUser('zhangsan').project.endsWith('beta-web'));
});

await test('a repeated msgid is dropped', async () => {
  const socket = h.socket();
  socket.reset();
  socket.receive(msgCallback({ reqId: 'REQ-DUP', msgid: 'MSG-DUP', content: '/help' }));
  await waitFor(() => socket.lastOf('aibot_respond_msg'));
  // Count only replies: heartbeats also land in `sent`.
  const count = socket.sent.filter((f) => f.cmd === 'aibot_respond_msg').length;
  socket.receive(msgCallback({ reqId: 'REQ-DUP2', msgid: 'MSG-DUP', content: '/help' }));
  await new Promise((r) => setTimeout(r, 80));
  const after = socket.sent.filter((f) => f.cmd === 'aibot_respond_msg').length;
  assert.equal(after, count, 'the duplicate must not produce another reply');
});

await test('non-text messages get a notice instead of reaching Codex', async () => {
  const socket = h.socket();
  socket.reset();
  socket.receive({
    cmd: 'aibot_msg_callback',
    headers: { req_id: 'REQ-IMG' },
    body: { msgid: 'MSG-IMG', chattype: 'single', from: { userid: 'zhangsan' }, msgtype: 'image', image: { url: 'u', aeskey: 'k' } },
  });
  await waitFor(() => socket.lastOf('aibot_respond_msg'));
  assert.ok(socket.lastOf('aibot_respond_msg').body.markdown.content.includes('只支持文字消息'));
});

await test('streaming uses msgtype stream with a stable stream.id and finish flag', async () => {
  const socket = h.socket();
  socket.reset();
  const ctx = { reqId: 'REQ-STREAM', userId: 'zhangsan', chattype: 'single' };
  const stream = h.transport.openStream(ctx);
  await stream.push('第一段');
  await stream.push('第二段');
  await stream.finish('最终答案');

  const frames = socket.sent.filter((f) => f.cmd === 'aibot_respond_msg');
  assert.ok(frames.length >= 3, `expected several stream frames, got ${frames.length}`);
  for (const frame of frames) {
    assert.equal(frame.headers.req_id, 'REQ-STREAM');
    assert.equal(frame.body.msgtype, 'stream');
  }
  const ids = new Set(frames.map((f) => f.body.stream.id));
  assert.equal(ids.size, 1, 'all pushes must reuse one stream.id');
  assert.equal(frames[0].body.stream.finish, false);
  assert.equal(frames.at(-1).body.stream.finish, true, 'the last frame must finish the stream');
  assert.equal(frames.at(-1).body.stream.content, '最终答案');
});

await test('stream content is cumulative, not appended deltas', async () => {
  const socket = h.socket();
  socket.reset();
  const stream = h.transport.openStream({ reqId: 'REQ-CUM', userId: 'u1' });
  await stream.push('A');
  await stream.push('B');
  const frames = socket.sent.filter((f) => f.cmd === 'aibot_respond_msg');
  assert.equal(frames[0].body.stream.content, 'A');
  assert.equal(frames[1].body.stream.content, 'AB', 'the doc says each push replaces the content');
});

await test('enter_chat gets a welcome message', async () => {
  const socket = h.socket();
  socket.reset();
  socket.receive({
    cmd: 'aibot_event_callback',
    headers: { req_id: 'REQ-EV' },
    body: { msgid: 'EV1', aibotid: 'BOTID123', from: { userid: 'zhangsan' }, msgtype: 'event', event: { eventtype: 'enter_chat' } },
  });
  await waitFor(() => socket.lastOf('aibot_respond_welcome_msg'));
  const frame = socket.lastOf('aibot_respond_welcome_msg');
  assert.equal(frame.headers.req_id, 'REQ-EV');
  assert.equal(frame.body.msgtype, 'markdown');
});

await test('@mention prefix is stripped for group chats', async () => {
  assert.equal(stripMention('@RobotA hello robot'), 'hello robot');
  assert.equal(stripMention('@机器人  帮我看下代码'), '帮我看下代码');
  assert.equal(stripMention('没有提mention'), '没有提mention');
});

await test('group chats are addressed by chatid when replying', async () => {
  const socket = h.socket();
  socket.reset();
  const ctx = { reqId: null, userId: 'zhangsan', chatId: 'CHAT-1', chatType: 'group' };
  await h.transport.send(ctx, '主动推送');
  const frame = socket.lastOf('aibot_send_msg');
  assert.ok(frame, 'without a req_id the transport must use aibot_send_msg');
  assert.equal(frame.body.chatid, 'CHAT-1');
  assert.equal(frame.body.chat_type, 2);
});

await test('single chats are addressed by userid with chat_type 1', async () => {
  const socket = h.socket();
  socket.reset();
  await h.transport.send({ userId: 'zhangsan', chatType: 'single' }, '主动推送');
  const frame = socket.lastOf('aibot_send_msg');
  assert.equal(frame.body.chatid, 'zhangsan');
  assert.equal(frame.body.chat_type, 1);
});

await test('a failed reply falls back to aibot_send_msg', async () => {
  const socket = h.socket();
  socket.reset();
  socket.autoReply = false;
  const promise = socket.send === undefined ? null : null;
  void promise;
  // Respond to aibot_respond_msg with an error, then let the fallback fire.
  const original = socket.send.bind(socket);
  socket.send = (raw) => {
    const frame = JSON.parse(raw);
    socket.sent.push(frame);
    if (frame.cmd === 'aibot_respond_msg') {
      queueMicrotask(() => socket.receive({ headers: { req_id: frame.headers.req_id }, errcode: 40001, errmsg: 'expired' }));
    } else {
      queueMicrotask(() => socket.receive({ headers: { req_id: frame.headers.req_id }, errcode: 0, errmsg: 'ok' }));
    }
  };
  await h.transport.send({ reqId: 'REQ-EXPIRED', userId: 'zhangsan', chatType: 'single' }, '结果');
  socket.send = original;
  socket.autoReply = true;
  const fallback = socket.lastOf('aibot_send_msg');
  assert.ok(fallback, 'must fall back so results are not lost');
  assert.equal(fallback.body.chatid, 'zhangsan');
});

await test('when streaming fails, updates stop and the result arrives as ONE message', async () => {
  const socket = h.socket();
  socket.reset();
  // Reject stream replies (expired req_id / rate limit) but keep plain pushes.
  socket.send = (raw) => {
    const frame = JSON.parse(raw);
    socket.sent.push(frame);
    const errcode = frame.cmd === 'aibot_respond_msg' ? 40001 : 0;
    queueMicrotask(() => socket.receive({
      headers: { req_id: frame.headers?.req_id },
      errcode,
      errmsg: errcode ? 'expired' : 'ok',
    }));
  };

  const ctx = { reqId: 'REQ-DEGRADED', userId: 'zhangsan', chatType: 'single' };
  const stream = h.transport.openStream(ctx);
  await stream.push('▶ 已收到 · 无项目 · 新会话\n\n');
  await stream.push('$ rg foo\n\n');
  await stream.push('$ ls\n\n');
  await stream.finish('最终答案');

  const attempts = socket.sent.filter((f) => f.cmd === 'aibot_respond_msg').length;
  const delivered = socket.sent.filter((f) => f.cmd === 'aibot_send_msg');
  assert.equal(attempts, 1, 'once the stream is unusable, stop trying on every update');
  assert.equal(delivered.length, 1, 'the result must arrive as exactly one message');
  assert.ok(delivered[0].body.markdown.content.includes('最终答案'), delivered[0].body.markdown.content);
  assert.ok(!delivered[0].body.markdown.content.includes('$ rg'), 'progress must not leak into the result');
  assert.equal(stream.isDegraded(), true);

  delete socket.send; // restore the prototype method for later tests
});

await test('a run longer than the stream limit still delivers its result', async () => {
  // The stream message has a 10-minute server-side cap. A 13-minute run pushes
  // keepalive updates, which trips the cap mid-run - and the result used to be
  // dropped on the floor because the stream was already marked finished.
  const socket = h.socket();
  socket.reset();
  const transport = createLongConnTransport({ client: h.client, logger, streamThrottleMs: 0, streamMaxMs: 50 });
  const ctx = { reqId: 'REQ-LONGRUN', userId: 'zhangsan', chatType: 'single' };

  const stream = transport.openStream(ctx);
  await stream.push('▶ 已收到 · 无项目 · 新会话\n\n');
  await new Promise((r) => setTimeout(r, 80));       // tip over the cap
  await stream.push('▶ 已收到 · 无项目 · 新会话\n\n⏳ 正在处理… 1m00s\n');
  await stream.finish('跑了十几分钟的结果');

  const closed = socket.sent.filter((f) => f.cmd === 'aibot_respond_msg' && f.body?.stream?.finish === true);
  assert.ok(closed.length >= 1, 'the stream must be closed when it hits the cap');

  const delivered = socket.sent.filter((f) => f.cmd === 'aibot_send_msg');
  assert.equal(delivered.length, 1, `the result must still arrive, got ${delivered.length} messages`);
  assert.ok(
    delivered[0].body.markdown.content.includes('跑了十几分钟的结果'),
    delivered[0].body.markdown.content,
  );
  assert.equal(stream.isFinished(), true);
});

await test('a reply sent during a reconnect is delivered instead of dropped', async () => {
  const hb = makeHarness({ reconnectMinMs: 20, reconnectMaxMs: 40 });
  hb.client.connect();
  hb.socket().open();
  await waitFor(() => hb.client.isReady);

  hb.socket().close();                                  // the link drops
  await waitFor(() => hb.sockets.length > 1, 1000);     // reconnect scheduled

  // The result comes back exactly while the socket is down: it must wait for
  // the new connection rather than being lost.
  const sending = hb.client.send({
    cmd: 'aibot_send_msg',
    headers: {},
    body: { chatid: 'zhangsan', chat_type: 1, msgtype: 'markdown', markdown: { content: '结果' } },
  });
  hb.socket().open();                                   // the reconnect lands
  const res = await sending;
  assert.equal(res.errcode, 0, 'the reply must be delivered after the reconnect');
  assert.ok(hb.socket().lastOf('aibot_send_msg'), 'the frame must reach the new socket');
  hb.client.close();
});

await test('disconnected_event stops auto-reconnect (avoiding a kick war)', async () => {
  const socket = h.socket();
  socket.receive({
    cmd: 'aibot_event_callback',
    headers: { req_id: 'REQ-DC' },
    body: { msgid: 'DC1', from: { userid: 'zhangsan' }, msgtype: 'event', event: { eventtype: 'disconnected_event' } },
  });
  assert.equal(h.client.replacedByPeer, true);
  const before = h.sockets.length;
  socket.close();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(h.sockets.length, before, 'must not open a new connection after being replaced');
});

await test('a plain disconnect does reconnect', async () => {
  const fresh = makeHarness();
  fresh.client.connect();
  fresh.socket().open();
  await waitFor(() => fresh.client.isReady);
  const before = fresh.sockets.length;
  fresh.socket().close();
  await waitFor(() => fresh.sockets.length > before, 3000);
  assert.ok(fresh.sockets.length > before, 'should retry the connection');
  fresh.client.close();
});

await test('a handshake failure retries even when close never fires', async () => {
  // Node's built-in WebSocket reports a failed handshake via `error` only, so
  // reconnect must not depend on `close`.
  const flaky = makeHarness();
  flaky.client.connect();
  const socket = flaky.socket();
  socket.onerror?.({ message: 'Received network error or non-101 status code.' });
  await waitFor(() => flaky.sockets.length > 1, 3000);
  assert.ok(flaky.sockets.length > 1, 'a failed connect must schedule another attempt');
  flaky.client.close();
});

let failed = 0;
console.log('\nLong-connection simulation (fake WebSocket)\n');
for (const [name, ok, detail] of results) {
  if (!ok) failed += 1;
  console.log(`  ${ok ? '\u2713' : '\u2717'} ${name}`);
  if (!ok) console.log(`      ${detail}`);
}
console.log(`\n${results.length - failed} passed, ${failed} failed`);
h.client.close();
process.exit(failed === 0 ? 0 : 1);
