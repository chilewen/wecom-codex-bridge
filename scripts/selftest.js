/**
 * Self-test for the pieces that are easy to get subtly wrong:
 * encryption round-trip, signature verification, XML parsing and chunking.
 *
 * Run: npm run selftest
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import path from 'node:path';

import {
  decryptMessage,
  encryptMessage,
  sha1Signature,
  verifySignature,
  unwrapCallback,
} from '../src/wecom-crypto.js';
import { parseXml, chunkText } from '../src/wecom.js';
import { discoverProjects, readCodexProjects, describeProjectSource } from '../src/projects.js';
import { buildArgs } from '../src/codex.js';
import { which, resolveCodexBin, CODEX_CANDIDATES } from '../src/bin-resolver.js';
import { describeAck, formatDuration } from '../src/bot.js';
import { createLongConnTransport } from '../src/transport.js';
import { DEFAULTS, mergeConfig } from '../src/config.js';
import { acceptKeyFor, encodeFrame, createFrameParser, MiniWebSocket, OPCODE } from '../src/ws-client.js';

const TOKEN = 'test-token-1234567890';
const AES_KEY = crypto.randomBytes(32).toString('base64').replace(/=+$/, '');
const CORP_ID = 'ww0123456789abcdef';

let passed = 0;
let failed = 0;
const asyncTests = [];
const pendingAsync = new Set();

function test(name, fn) {
  const pass = () => {
    passed += 1;
    console.log(`  ✓ ${name}`);
  };
  const fail = (err) => {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${err.message}`);
  };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      pendingAsync.add(name);
      asyncTests.push(result.then(pass, fail).finally(() => pendingAsync.delete(name)));
    }
    else pass();
  } catch (err) {
    fail(err);
  }
}

console.log('wecom-crypto');

test('AES key decodes to 32 bytes', () => {
  assert.equal(Buffer.from(`${AES_KEY}=`, 'base64').length, 32);
});

test('encrypt → decrypt round-trip preserves content and receiveId', () => {
  const plaintext = '<xml><Content><![CDATA[你好，world! <&>]]></Content></xml>';
  const encrypted = encryptMessage({ plaintext, encodingAESKey: AES_KEY, receiveId: CORP_ID });
  const out = decryptMessage({ encrypt: encrypted, encodingAESKey: AES_KEY });
  assert.equal(out.message, plaintext);
  assert.equal(out.receiveId, CORP_ID);
});

test('ciphertext is 32-byte block aligned and base64', () => {
  const encrypted = encryptMessage({ plaintext: 'abcdef', encodingAESKey: AES_KEY, receiveId: CORP_ID });
  assert.equal(Buffer.from(encrypted, 'base64').length % 32, 0);
});

test('each encryption uses fresh random padding', () => {
  const a = encryptMessage({ plaintext: 'same', encodingAESKey: AES_KEY, receiveId: CORP_ID });
  const b = encryptMessage({ plaintext: 'same', encodingAESKey: AES_KEY, receiveId: CORP_ID });
  assert.notEqual(a, b);
});

test('signature matches sorted sha1 of token/timestamp/nonce/encrypt', () => {
  const expected = crypto
    .createHash('sha1')
    .update([TOKEN, '123', 'abc', 'CIPHER'].sort().join(''))
    .digest('hex');
  assert.equal(sha1Signature(TOKEN, '123', 'abc', 'CIPHER'), expected);
});

test('verifySignature accepts the correct signature and rejects a wrong one', () => {
  const sig = sha1Signature(TOKEN, '1700000000', 'nonce', 'CIPHER');
  assert.ok(verifySignature({ token: TOKEN, timestamp: '1700000000', nonce: 'nonce', encrypt: 'CIPHER', signature: sig }));
  assert.ok(!verifySignature({ token: TOKEN, timestamp: '1700000000', nonce: 'nonce', encrypt: 'CIPHER', signature: 'deadbeef' }));
});

test('full inbound unpack: signature → decrypt → inner XML', () => {
  const inner = '<xml><ToUserName><![CDATA[bot]]></ToUserName><FromUserName><![CDATA[zhangsan]]></FromUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[帮我改个 bug]]></Content><MsgId>42</MsgId></xml>';
  const encrypt = encryptMessage({ plaintext: inner, encodingAESKey: AES_KEY, receiveId: CORP_ID });
  const timestamp = '1700000000';
  const nonce = 'nonce123';
  const msg_signature = sha1Signature(TOKEN, timestamp, nonce, encrypt);

  const result = unwrapCallback({
    query: { msg_signature, timestamp, nonce, encrypt },
    token: TOKEN,
    encodingAESKey: AES_KEY,
  });
  const parsed = parseXml(result.message);
  assert.equal(parsed.FromUserName, 'zhangsan');
  assert.equal(parsed.Content, '帮我改个 bug');
});

test('tampered signature is rejected', () => {
  const encrypt = encryptMessage({ plaintext: '<xml/>', encodingAESKey: AES_KEY, receiveId: CORP_ID });
  assert.throws(
    () => unwrapCallback({ query: { msg_signature: 'nope', timestamp: '1', nonce: '2', encrypt }, token: TOKEN, encodingAESKey: AES_KEY }),
    /Signature mismatch/,
  );
});

test('strictReceiveId rejects a mismatched corpId', () => {
  const encrypt = encryptMessage({ plaintext: '<xml/>', encodingAESKey: AES_KEY, receiveId: 'attacker' });
  const timestamp = '1';
  const nonce = '2';
  const msg_signature = sha1Signature(TOKEN, timestamp, nonce, encrypt);
  assert.throws(
    () => unwrapCallback({
      query: { msg_signature, timestamp, nonce, encrypt },
      token: TOKEN,
      encodingAESKey: AES_KEY,
      strictReceiveId: true,
      expectedReceiveId: CORP_ID,
    }),
    /receiveId mismatch/,
  );
});

console.log('wecom (parsing / formatting)');

test('parseXml handles CDATA, plain values and nested tags', () => {
  const parsed = parseXml('<xml><A><![CDATA[x<y]]></A><B>plain</B><C><D>1</D></C></xml>');
  assert.equal(parsed.A, 'x<y');
  assert.equal(parsed.B, 'plain');
  assert.equal(parsed.D, '1');
});

test('chunkText keeps multi-byte characters intact', () => {
  const chunks = chunkText('中'.repeat(1000), 1024);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk, 'utf8') <= 1024);
    assert.equal(chunk, '中'.repeat(chunk.length));
  }
  assert.equal(chunks.join(''), '中'.repeat(1000));
});

test('chunkText never returns an empty list', () => {
  assert.deepEqual(chunkText('   '), ['(空回复)']);
});

console.log('codex (cli args)');

const baseConfig = { codex: { bin: 'codex', sandbox: 'workspace-write', model: '', extraArgs: [], bypassApprovalsAndSandbox: false } };

test('new session passes -C and --json', () => {
  const args = buildArgs({ config: baseConfig, cwd: '/tmp/proj', sessionId: null });
  assert.equal(args[0], 'exec');
  assert.ok(args.includes('--json'));
  assert.deepEqual(args.slice(args.indexOf('-C'), args.indexOf('-C') + 2), ['-C', '/tmp/proj']);
});

test('resume omits flags that `exec resume` does not support', () => {
  const args = buildArgs({ config: baseConfig, cwd: '/tmp/proj', sessionId: 'abc-123' });
  assert.ok(args.includes('resume'));
  assert.ok(args.includes('abc-123'));
  assert.ok(!args.includes('-C'), 'resume must not receive -C');
  assert.ok(!args.includes('--color'), 'resume must not receive --color');
  assert.ok(!args.includes('-s'), 'resume must not receive -s');
});

console.log('projects');

test('discoverProjects merges explicit entries and scan roots (source=scan)', () => {
  const list = discoverProjects({
    projects: { source: 'scan', list: [{ name: 'explicit', path: '/tmp' }], roots: [], scanDepth: 1 },
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'explicit');
});

/** A throwaway Codex state file so these tests never read the real one. */
function codexStateFixture(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-state-'));
  const state = { 'local-projects': {}, 'project-order': [] };
  for (const { id, name, order } of entries) {
    const root = path.join(dir, name);
    fs.mkdirSync(root, { recursive: true });
    state['local-projects'][id] = { id, name, rootPaths: [root] };
    if (order !== false) state['project-order'].push(id);
  }
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(state));
  return { dir, stateFile };
}

test('readCodexProjects follows project-order (the sidebar order), not insertion order', () => {
  const { stateFile } = codexStateFixture([
    { id: 'id1', name: '第二个' },
    { id: 'id2', name: '第一个' },
  ]);
  const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  raw['project-order'] = ['id2', 'id1'];
  fs.writeFileSync(stateFile, JSON.stringify(raw));

  const projects = readCodexProjects({ stateFile });
  assert.deepEqual(projects.map((p) => p.name), ['第一个', '第二个']);
  assert.equal(projects[0].source, 'codex');
});

test('readCodexProjects appends projects missing from project-order', () => {
  const { stateFile } = codexStateFixture([
    { id: 'id1', name: '有序' },
    { id: 'id2', name: '没进顺序' },
  ]);
  const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  raw['project-order'] = ['id1'];
  fs.writeFileSync(stateFile, JSON.stringify(raw));

  const names = readCodexProjects({ stateFile }).map((p) => p.name);
  assert.deepEqual(names, ['有序', '没进顺序']);
});

test('readCodexProjects skips entries whose directory is gone', () => {
  const { dir, stateFile } = codexStateFixture([{ id: 'id1', name: '还在' }]);
  const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  raw['local-projects'].id2 = { id: 'id2', name: '删了', rootPaths: [path.join(dir, 'gone')] };
  raw['project-order'] = ['id1', 'id2'];
  fs.writeFileSync(stateFile, JSON.stringify(raw));

  assert.deepEqual(readCodexProjects({ stateFile }).map((p) => p.name), ['还在']);
  assert.equal(readCodexProjects({ stateFile, onlyExisting: false }).length, 2);
});

test('readCodexProjects returns [] instead of throwing when the state file is missing', () => {
  assert.deepEqual(readCodexProjects({ stateFile: '/no/such/codex-state.json' }), []);
});

test('discoverProjects defaults to the Codex project list', () => {
  const { stateFile } = codexStateFixture([{ id: 'id1', name: 'Codex项目' }]);
  const list = discoverProjects({
    projects: { source: 'codex', codexStateFile: stateFile, list: [], roots: [], scanDepth: 1 },
  });
  assert.deepEqual(list.map((p) => p.name), ['Codex项目']);
  assert.equal(describeProjectSource(list), 'Codex 项目列表');
});

test('discoverProjects falls back to scanning when the Codex list is unreadable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-fallback-'));
  const repo = path.join(dir, 'some-repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const list = discoverProjects({
    projects: { source: 'codex', codexStateFile: path.join(dir, 'missing.json'), list: [], roots: [dir], scanDepth: 2 },
  });
  // The scan root itself is offered too, plus the repo found inside it.
  assert.ok(list.some((p) => p.name === 'some-repo'), JSON.stringify(list));
  assert.equal(describeProjectSource(list), '扫描目录');
});

test('with projects.roots empty, no directory is ever scanned', () => {
  // This is the "stop reading ~/Desktop/code-git" case: the Codex list is the
  // only source, and an unreadable state file yields no projects rather than a
  // silent switch to scanning the disk.
  const list = discoverProjects({
    projects: { source: 'codex', codexStateFile: '/no/such/codex-state.json', list: [], roots: [], scanDepth: 3 },
  });
  assert.deepEqual(list, []);
});

test('discoverProjects source="scan" ignores the Codex list entirely', () => {
  const { stateFile } = codexStateFixture([{ id: 'id1', name: 'Codex项目' }]);
  const list = discoverProjects({
    projects: { source: 'scan', codexStateFile: stateFile, list: [], roots: [], scanDepth: 1 },
  });
  assert.deepEqual(list, []);
});

test('discoverProjects source="both" lists Codex projects before scanned ones', () => {
  const { dir, stateFile } = codexStateFixture([{ id: 'id1', name: 'Codex项目' }]);
  const repo = path.join(dir, 'zzz-repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const list = discoverProjects({
    projects: { source: 'both', codexStateFile: stateFile, list: [], roots: [dir], scanDepth: 2 },
  });
  assert.equal(list[0].name, 'Codex项目');
  assert.ok(list.some((p) => p.name === 'zzz-repo'));
  assert.equal(describeProjectSource(list), 'Codex 项目列表 + 扫描目录');
});

test('discoverProjects puts explicit entries first and de-duplicates by path', () => {
  const { stateFile, dir } = codexStateFixture([{ id: 'id1', name: 'Codex项目' }]);
  const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const codexPath = raw['local-projects'].id1.rootPaths[0];
  void dir;
  const list = discoverProjects({
    projects: {
      source: 'codex',
      codexStateFile: stateFile,
      // Same path as the Codex project, but with an override name.
      list: [{ name: '我的别名', path: codexPath }],
      roots: [],
      scanDepth: 1,
    },
  });
  assert.equal(list.length, 1, 'the explicit entry and the Codex entry are the same project');
  assert.equal(list[0].name, '我的别名');
  assert.equal(list[0].source, 'config');
});

console.log('bot (reply wording)');

test('ack distinguishes a fresh session from a resumed one', () => {
  const fresh = describeAck({ label: 'flutter_qiezi', hasSession: false });
  const resumed = describeAck({ label: 'flutter_qiezi', hasSession: true });
  assert.ok(fresh.includes('新会话'), fresh);
  assert.ok(resumed.includes('继续会话'), resumed);
  assert.notEqual(fresh, resumed, 'the two cases must be visibly different');
});

test('ack names the project so a sticky project is not mistaken for a new chat', () => {
  const ack = describeAck({ projectPath: '/Users/me/code-git/qiezi-web', hasSession: false });
  assert.ok(ack.includes('qiezi-web'), ack);
  assert.ok(!ack.includes('/Users/me'), 'should show the basename, not the full path');
});

test('codex.networkAccess adds the sandbox network override, and only when on', () => {
  const base = { codex: { ...DEFAULTS.codex } };
  const off = buildArgs({ config: { codex: { ...base.codex, networkAccess: false } }, cwd: '/tmp', sessionId: null });
  assert.ok(!off.includes('sandbox_workspace_write.network_access=true'), off.join(' '));

  const on = buildArgs({ config: { codex: { ...base.codex, networkAccess: true } }, cwd: '/tmp', sessionId: null });
  const at = on.indexOf('-c');
  assert.ok(at > -1, `expected a -c override: ${on.join(' ')}`);
  assert.equal(on[at + 1], 'sandbox_workspace_write.network_access=true');
});

test('the network override is also passed on the resume path', () => {
  // `codex exec resume` rejects -C/-s but does accept -c, so a resumed
  // conversation must not silently lose network access.
  const args = buildArgs({
    config: { codex: { ...DEFAULTS.codex, networkAccess: true } },
    cwd: '/tmp',
    sessionId: 'session-123',
  });
  assert.equal(args[0], 'exec');
  assert.equal(args[1], 'resume');
  assert.ok(args.includes('sandbox_workspace_write.network_access=true'), args.join(' '));
  assert.ok(!args.includes('-C'), 'resume must not receive -C');
});

test('formatDuration stays short and padded', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(65_000), '1m05s');
  assert.equal(formatDuration(780_000), '13m00s');
  assert.equal(formatDuration(3_725_000), '1h02m');
  assert.equal(formatDuration(-5), '0s', 'a clock skew must not print -0s');
});

test('ack labels 无项目 mode as such rather than naming a directory', () => {
  const ack = describeAck({ label: '无项目', hasSession: false });
  assert.ok(ack.includes('无项目'), ack);
  assert.ok(ack.includes('新会话'), ack);
});

test('progress lines are off by default (chat stays quiet until the result)', () => {
  assert.equal(DEFAULTS.codex.streamProgress, false);
  const merged = mergeConfig(DEFAULTS, { codex: { streamProgress: true } });
  assert.equal(merged.codex.streamProgress, true, 'the switch must still work');
});

test('the ack is on by default and can be turned off', () => {
  assert.equal(DEFAULTS.codex.showAck, true);
  assert.equal(mergeConfig(DEFAULTS, { codex: { showAck: false } }).codex.showAck, false);
});

console.log('bin-resolver');

test('which() finds an executable on a synthetic PATH', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'which-test-'));
  const fake = path.join(dir, 'my-codex');
  fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(which('my-codex', { PATH: dir }), fake);
  assert.equal(which('my-codex', { PATH: '/nonexistent' }), null);
});

test('which() ignores non-executable files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'which-test-'));
  fs.writeFileSync(path.join(dir, 'not-exec'), 'x', { mode: 0o644 });
  assert.equal(which('not-exec', { PATH: dir }), null);
});

test('resolveCodexBin honours an absolute configured path', () => {
  const resolved = resolveCodexBin({ codex: { bin: process.execPath } });
  assert.equal(resolved.bin, process.execPath);
  assert.equal(resolved.source, 'configured');
});

test('resolveCodexBin gives actionable help for a bad configured path', () => {
  assert.throws(
    () => resolveCodexBin({ codex: { bin: '/no/such/codex-binary' } }),
    (err) => err.message.includes('/no/such/codex-binary')
      && err.message.includes('npm i -g @openai/codex')
      && err.message.includes('"bin"'),
  );
});

test('resolveCodexBin survives an empty PATH (the reported ENOENT case)', () => {
  // A plain terminal has no `codex` on PATH, so resolution must fall back to
  // known install locations rather than dying in spawn().
  const env = { PATH: '/nonexistent' };
  const hasCandidate = CODEX_CANDIDATES.some((c) => fs.existsSync(c));
  if (hasCandidate) {
    const resolved = resolveCodexBin({ codex: { bin: 'codex' } }, env);
    assert.equal(resolved.source, 'candidate');
    assert.ok(fs.existsSync(resolved.bin));
  } else {
    assert.throws(() => resolveCodexBin({ codex: { bin: 'codex' } }, env), /could not find a runnable/);
  }
});

console.log('transport (WeCom stream updates)');

function streamContents(frames) {
  return frames
    .filter((f) => f.cmd === 'aibot_respond_msg' && f.body?.msgtype === 'stream')
    .map((f) => f.body.stream.content);
}

test('concurrent deltas never send a shorter stream snapshot', async () => {
  const frames = [];
  const client = { send: async (frame) => { frames.push(frame); return { errcode: 0 }; } };
  const { openStream } = createLongConnTransport({
    client, logger: { error() {} }, streamThrottleMs: 0,
  });
  const stream = openStream({ reqId: 'req-1', userId: 'u1' });

  await stream.push('▶ 已收到\n\n');
  await Promise.all(['先', '确认', '一下', '：', '腾格里', '沙漠'].map((d) => stream.push(d)));
  await stream.finish('▶ 已收到\n\n先确认一下：腾格里沙漠的完整方案');

  const contents = streamContents(frames);
  for (let i = 1; i < contents.length; i += 1) {
    assert.ok(contents[i].length >= contents[i - 1].length, `content shrank at update ${i}`);
  }
  assert.equal(contents.at(-1), '▶ 已收到\n\n先确认一下：腾格里沙漠的完整方案');
});

test('failed stream update closes the old bubble before falling back', async () => {
  const frames = [];
  let calls = 0;
  const client = {
    send: async (frame) => {
      frames.push(frame);
      calls += 1;
      if (calls === 2 || calls === 3) return { errcode: 40001, errmsg: 'invalid req_id' };
      return { errcode: 0 };
    },
  };
  const { openStream } = createLongConnTransport({
    client, logger: { error() {} }, streamThrottleMs: 0,
  });
  const stream = openStream({ reqId: 'req-2', userId: 'u1' });

  await stream.push('ack\n\n');
  await stream.push('正文');
  await stream.finish('正文完整');

  const streams = frames.filter((f) => f.body?.msgtype === 'stream');
  const plains = frames.filter((f) => f.body?.msgtype === 'markdown');
  assert.equal(streams.at(-1)?.body.stream.finish, true, 'should try to finish the bubble');
  assert.equal(plains.length, 1, 'should fall back to one plain message');
  assert.equal(plains[0].body.markdown.content, '正文完整');
});

test('resolveCodexBin resolves a bare name that IS on PATH', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'which-test-'));
  const fake = path.join(dir, 'codex');
  fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const resolved = resolveCodexBin({ codex: { bin: 'codex' } }, { PATH: dir });
  assert.equal(resolved.bin, fake);
  assert.equal(resolved.source, 'path');
});

test('resolveCodexBin revalidates a cached path that disappeared', () => {
  // A long-running bridge cached the CLI path, then the ChatGPT app updated and
  // replaced its Resources tree, leaving the cached path dangling. Resolution
  // must notice and re-resolve instead of handing spawn a path that ENOENTs.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'which-stale-'));
  const fake = path.join(dir, 'codex');
  fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = { PATH: dir };

  assert.equal(resolveCodexBin({ codex: { bin: 'codex' } }, env).bin, fake);
  fs.rmSync(fake);

  const hasCandidate = CODEX_CANDIDATES.some((c) => fs.existsSync(c));
  if (hasCandidate) {
    const resolved = resolveCodexBin({ codex: { bin: 'codex' } }, env);
    assert.notEqual(resolved.bin, fake);
    assert.ok(fs.existsSync(resolved.bin));
  } else {
    assert.throws(() => resolveCodexBin({ codex: { bin: 'codex' } }, env));
  }
});

console.log('ws-client (RFC 6455)');

// The built-in WebSocket could not complete the handshake with WeCom, so we
// ship our own. These tests pin the wire format so a refactor cannot silently
// break it.
function serverFrame(opcode, payload, { fin = true } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = (fin ? 0x80 : 0x00) | opcode;
  return Buffer.concat([header, body]);
}

test('acceptKeyFor matches the RFC 6455 handshake vector', () => {
  assert.equal(acceptKeyFor('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('encodeFrame sets FIN, the opcode, and the client mask bit', () => {
  const frame = encodeFrame(OPCODE.TEXT, 'hi');
  assert.equal(frame[0], 0x80 | OPCODE.TEXT);
  assert.equal(frame[1] & 0x80, 0x80, 'client frames must be masked');
  assert.equal(frame[1] & 0x7f, 2);
  assert.equal(frame.length, 2 + 4 + 2);
});

test('encodeFrame uses 16-bit length for 126..65535 and 64-bit beyond', () => {
  const medium = encodeFrame(OPCODE.TEXT, Buffer.alloc(65535));
  assert.equal(medium[1] & 0x7f, 126);
  assert.equal(medium.readUInt16BE(2), 65535);

  const large = encodeFrame(OPCODE.TEXT, Buffer.alloc(70000));
  assert.equal(large[1] & 0x7f, 127);
  assert.equal(Number(large.readBigUInt64BE(2)), 70000);
});

test('parser round-trips a masked client frame back to its payload', () => {
  const parser = createFrameParser();
  const frames = parser.push(encodeFrame(OPCODE.TEXT, '你好, Codex'));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].opcode, OPCODE.TEXT);
  assert.equal(frames[0].fin, true);
  assert.equal(frames[0].payload.toString('utf8'), '你好, Codex');
});

test('parser reassembles a frame delivered one byte at a time', () => {
  const parser = createFrameParser();
  const wire = encodeFrame(OPCODE.TEXT, 'streamed in pieces');
  const seen = [];
  for (const byte of wire) seen.push(...parser.push(Buffer.from([byte])));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].payload.toString('utf8'), 'streamed in pieces');
});

test('parser keeps an incomplete frame buffered until the rest arrives', () => {
  const parser = createFrameParser();
  const wire = encodeFrame(OPCODE.TEXT, 'abcdef');
  assert.deepEqual(parser.push(wire.subarray(0, 5)), []);
  const frames = parser.push(wire.subarray(5));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.toString('utf8'), 'abcdef');
});

test('parser concatenates fragmented data frames into one message', () => {
  const parser = createFrameParser();
  const wire = Buffer.concat([
    serverFrame(OPCODE.TEXT, 'Hello, ', { fin: false }),
    serverFrame(OPCODE.CONTINUATION, 'WeCom', { fin: false }),
    serverFrame(OPCODE.CONTINUATION, '!', { fin: true }),
  ]);
  const frames = parser.push(wire);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].opcode, OPCODE.TEXT);
  assert.equal(frames[0].payload.toString('utf8'), 'Hello, WeCom!');
});

test('parser surfaces control frames interleaved inside a fragmented message', () => {
  const parser = createFrameParser();
  const wire = Buffer.concat([
    serverFrame(OPCODE.TEXT, 'part1', { fin: false }),
    serverFrame(OPCODE.PING, 'keepalive'),
    serverFrame(OPCODE.CONTINUATION, 'part2', { fin: true }),
  ]);
  const frames = parser.push(wire);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].opcode, OPCODE.PING);
  assert.equal(frames[0].payload.toString('utf8'), 'keepalive');
  assert.equal(frames[1].opcode, OPCODE.TEXT);
  assert.equal(frames[1].payload.toString('utf8'), 'part1part2');
});

test('parser rejects an oversized frame instead of allocating it', () => {
  const parser = createFrameParser();
  const header = Buffer.alloc(10);
  header[0] = 0x80 | OPCODE.TEXT;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(64 * 1024 * 1024), 2);
  assert.throws(() => parser.push(header), /too large/);
});


/**
 * A fake socket. Some sandboxes refuse to `listen()` on a port, so the
 * handshake, masking and control-frame paths are also exercised against a
 * scripted socket instead of a real server.
 */
function fakeSocket() {
  const socket = new EventEmitter();
  socket.sent = [];
  socket.destroyed = false;
  socket.setNoDelay = () => {};
  socket.write = (buf) => {
    const bytes = Buffer.from(buf);
    // The first write is the HTTP upgrade request; everything after it is a frame.
    if (socket.sent.length === 0) socket.handshakeBytes = bytes.length;
    socket.sent.push(bytes);
    return true;
  };
  socket.end = (buf) => {
    if (buf) socket.write(buf);
  };
  socket.destroy = () => {
    socket.destroyed = true;
  };
  socket.feed = (buf) => socket.emit('data', Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8'));
  socket.sentText = () => Buffer.concat(socket.sent).toString('utf8');
  socket.framesSent = () => {
    const all = Buffer.concat(socket.sent);
    const body = socket.handshakeBytes ? all.subarray(socket.handshakeBytes) : all;
    return body.length ? createFrameParser().push(body) : [];
  };
  return socket;
}

function openClient({ url = 'wss://openws.work.weixin.qq.com/', ...options } = {}) {
  const socket = fakeSocket();
  const ws = new MiniWebSocket(url, { ...options, connect: () => socket });
  const readyEvent = url.startsWith('wss:') ? 'secureConnect' : 'connect';
  const handshakeKey = () => (/Sec-WebSocket-Key: (.+)\r\n/.exec(socket.sentText()) ?? [])[1];
  return {
    ws,
    socket,
    handshakeKey,
    /** Finishes the transport-level connection (TCP, or TLS for wss). */
    connect() {
      socket.emit(readyEvent);
      return socket;
    },
    /** Emits the server's 101 reply. Handlers must be attached first. */
    accept({ accept, status = '101 Switching Protocols', includeUpgrade = true } = {}) {
      const lines = [`HTTP/1.1 ${status}`, 'Connection: Upgrade'];
      if (includeUpgrade) lines.push('Upgrade: websocket');
      lines.push(`Sec-WebSocket-Accept: ${accept ?? acceptKeyFor(handshakeKey())}`);
      socket.feed(`${lines.join('\r\n')}\r\n\r\n`);
      return socket;
    },
    opened() {
      return new Promise((resolve, reject) => {
        ws.onopen = () => resolve(ws);
        ws.onerror = (event) => reject(new Error(event.message));
      });
    },
    errored() {
      return new Promise((resolve) => {
        ws.onerror = (event) => resolve(event);
      });
    },
  };
}

test('MiniWebSocket writes a compliant RFC 6455 handshake by hand', () => {
  const client = openClient();
  const request = client.ws.requestBytes;
  const lines = request.split('\r\n');
  assert.equal(lines[0], 'GET / HTTP/1.1');
  assert.ok(lines.includes('Host: openws.work.weixin.qq.com'), 'Host must be present');
  assert.ok(lines.includes('Connection: Upgrade'));
  assert.ok(lines.includes('Upgrade: websocket'));
  assert.ok(lines.includes('Sec-WebSocket-Version: 13'));
  const keyLine = lines.find((line) => line.startsWith('Sec-WebSocket-Key: '));
  assert.ok(keyLine, 'a Sec-WebSocket-Key must be generated');
  assert.equal(Buffer.from(keyLine.slice('Sec-WebSocket-Key: '.length), 'base64').length, 16);
  assert.ok(request.endsWith('\r\n\r\n'), 'the request must end with a blank line');
  client.connect();
  client.accept();
});

test('MiniWebSocket adds a non-default port to Host', () => {
  const client = openClient({ url: 'ws://127.0.0.1:9100/stream' });
  assert.equal(client.ws.requestBytes.split('\r\n')[0], 'GET /stream HTTP/1.1');
  assert.ok(client.ws.requestBytes.split('\r\n').includes('Host: 127.0.0.1:9100'));
});

test('MiniWebSocket opens once the server accepts, and round-trips a masked text frame', async () => {
  const client = openClient();
  client.connect();
  const opened = client.opened();
  client.accept();
  const { ws, socket } = client;
  await opened;
  assert.equal(ws.readyState, 1);

  const received = [];
  ws.onmessage = (ev) => received.push(ev.data);
  ws.send('你好，企微');

  const sent = socket.framesSent();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].opcode, OPCODE.TEXT);
  assert.equal(sent[0].payload.toString('utf8'), '你好，企微');
  const frameBytes = Buffer.concat(socket.sent).subarray(socket.handshakeBytes);
  assert.ok(frameBytes[1] & 0x80, 'client frames must carry the mask bit');

  socket.feed(serverFrame(OPCODE.TEXT, '正在处理…'));
  assert.deepEqual(received, ['正在处理…']);
});

test('MiniWebSocket delivers a frame glued to the handshake response', async () => {
  const client = openClient();
  client.connect();
  const received = [];
  client.ws.onmessage = (ev) => received.push(ev.data);
  const opened = client.opened();

  const key = client.handshakeKey();
  const head = 'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: upgrade\r\n'
    + `Sec-WebSocket-Accept: ${acceptKeyFor(key)}\r\n\r\n`;
  const bytes = Buffer.concat([Buffer.from(head, 'utf8'), serverFrame(OPCODE.TEXT, 'glued')]);
  // Split mid-header to make sure the parser buffers across packets.
  client.socket.feed(bytes.subarray(0, 30));
  client.socket.feed(bytes.subarray(30));

  await opened;
  assert.deepEqual(received, ['glued']);
});

test('MiniWebSocket answers a server ping with a pong, silently', async () => {
  const client = openClient();
  client.connect();
  const opened = client.opened();
  client.accept();
  await opened;
  const { ws, socket } = client;

  let messages = 0;
  ws.onmessage = () => { messages += 1; };
  socket.feed(serverFrame(OPCODE.PING, 'hb'));

  const sent = socket.framesSent();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].opcode, OPCODE.PONG);
  assert.equal(sent[0].payload.toString('utf8'), 'hb');
  assert.equal(messages, 0, 'a ping is not a message');
});

test('MiniWebSocket rejects a mismatched Sec-WebSocket-Accept', async () => {
  const client = openClient();
  client.connect();
  const errored = client.errored();
  client.accept({ accept: 'totally-wrong' });
  const err = await errored;
  assert.match(err.message, /Sec-WebSocket-Accept/);
  assert.equal(client.ws.readyState, 3);
});

test('MiniWebSocket reports an HTTP refusal with its status code and body', async () => {
  const client = openClient();
  client.connect();
  const errored = client.errored();
  client.socket.feed(
    'HTTP/1.1 404 Not Found\r\nServer: Wwebsvr\r\nContent-Length: 14\r\n\r\nupgrade denied',
  );
  const err = await errored;
  assert.match(err.message, /404/);
  assert.match(err.message, /upgrade denied/);
});

test('MiniWebSocket surfaces a server close frame and goes to CLOSED', async () => {
  const client = openClient();
  client.connect();
  const opened = client.opened();
  client.accept();
  await opened;
  const { ws, socket } = client;

  const closed = new Promise((resolve) => { ws.onclose = resolve; });
  socket.feed(serverFrame(OPCODE.CLOSE, Buffer.from([0x03, 0xe8])));
  const ev = await closed;
  assert.equal(ev.code, 1000);
  assert.equal(ws.readyState, 3);
  assert.equal(socket.framesSent()[0].opcode, OPCODE.CLOSE, 'must answer the close handshake');
});

test('MiniWebSocket times out a silent handshake', async () => {
  const client = openClient({ handshakeTimeoutMs: 30 });
  client.connect();
  const err = await client.errored();
  assert.match(err.message, /handshake timed out/);
  assert.equal(client.ws.readyState, 3);
});

test('MiniWebSocket reports a failed connect exactly once (error then close)', async () => {
  const client = openClient();
  client.connect();
  const messages = [];
  client.ws.onerror = (event) => messages.push(event.message);
  client.socket.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:443'));
  client.socket.emit('close');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(messages, ['connect ECONNREFUSED 127.0.0.1:443']);
  assert.equal(client.ws.readyState, 3);
});

test('MiniWebSocket reports a transport error during the handshake', async () => {
  const client = openClient();
  client.connect();
  const errored = client.errored();
  client.socket.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:443'));
  const err = await errored;
  assert.match(err.message, /ECONNREFUSED/);
  assert.equal(client.ws.readyState, 3);
});

test('MiniWebSocket completes a real handshake against a local server', async () => {
  const server = http.createServer();
  server.on('error', () => {});
  const upgraded = new Set();
  server.on('upgrade', (req, socket) => {
    socket.on('error', () => {});
    upgraded.add(socket);
    socket.on('close', () => upgraded.delete(socket));
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${acceptKeyFor(req.headers['sec-websocket-key'])}\r\n\r\n`,
    );
    const parser = createFrameParser();
    socket.on('data', (chunk) => {
      for (const frame of parser.push(chunk)) {
        if (frame.opcode === OPCODE.TEXT) {
          socket.write(serverFrame(OPCODE.TEXT, `echo:${frame.payload.toString('utf8')}`));
        }
      }
    });
  });
  let listening = false;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    listening = true;
  } catch (err) {
    // Sandboxes that forbid binding a port still need the suite to pass.
    assert.ok(['EPERM', 'EACCES'].includes(err.code), `unexpected listen failure: ${err.message}`);
    return;
  } finally {
    if (!listening) await new Promise((resolve) => server.close(resolve));
  }
  let ws = null;
  try {
    ws = new MiniWebSocket(`ws://127.0.0.1:${server.address().port}`);
    await Promise.race([
      new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = (event) => reject(new Error(event.message));
      }),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`open timeout readyState=${ws.readyState} handshakeDone=${ws.handshakeDone}`)),
        5000,
      )),
    ]);
    const reply = await new Promise((resolve) => {
      ws.onmessage = (ev) => resolve(ev.data);
      ws.send('hello');
    });
    assert.equal(reply, 'echo:hello');
  } finally {
    // Upgraded sockets are detached from http.Server.close(), so close both
    // ends explicitly or the close callback never fires and the suite hangs.
    for (const socket of upgraded) {
      try { socket.destroy(); } catch { /* ignore */ }
    }
    try { ws?.socket?.destroy(); } catch { /* ignore */ }
    await new Promise((resolve) => server.close(resolve));
  }
});

// Fail loudly instead of hanging forever when one async case never settles.
const guard = setTimeout(() => {
  console.error(`\n未完成的异步测试：${[...pendingAsync].join('、') || '(未知)'}`);
  process.exit(1);
}, 12000);

await Promise.all(asyncTests);
clearTimeout(guard);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
