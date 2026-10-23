/**
 * Local terminal REPL that drives the same Bridge the WeCom integration uses.
 *
 * Purpose: prove the "project selection + Codex execution" half of the bridge
 * works before the WeCom transport is wired up. Same commands, same queue, same
 * session resumption - only the transport is swapped for stdout.
 *
 *   npm run chat
 *   npm run chat -- --user zhangsan
 */
import readline from 'node:readline';
import path from 'node:path';

import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/sessions.js';
import { discoverProjects, describeProjectSource } from '../src/projects.js';
import { Bridge } from '../src/bot.js';
import { resolveCodexBin } from '../src/bin-resolver.js';
import { createConsoleTransport } from '../src/transport.js';

const argv = process.argv.slice(2);
const userIndex = argv.indexOf('--user');
const userId = userIndex !== -1 ? argv[userIndex + 1] : 'local-tester';

// The REPL never talks to WeCom, so WeCom credentials are not required here.
const config = loadConfig(process.env.BRIDGE_CONFIG, { requireWecom: false });
const store = new StateStore(config.stateFile);
const projects = discoverProjects(config);

const transport = createConsoleTransport();
const bridge = new Bridge({ config, store, projects, transport, logger: console });

console.log('Codex 本地对话（和企微机器人共用同一套逻辑）');
console.log(`  用户      : ${userId}`);
console.log(`  发现项目  : ${projects.length} 个（${describeProjectSource(projects) || '无'}）`);
let codexBin = '⚠️ 未找到';
try {
  const resolved = resolveCodexBin(config);
  codexBin = `${resolved.bin}${resolved.source === 'candidate' ? '  (自动探测)' : ''}`;
} catch (err) {
  codexBin = `未找到 —— ${err.message.split('\n')[0]}`;
}
console.log(`  codex     : ${codexBin}`);
console.log(`  沙箱      : ${config.codex.sandbox}`);
console.log('  输入消息直接提问；/help 看命令；/quit 退出\n');

if (!projects.length) {
  console.log('⚠️  没有发现任何项目，先在 config.json 里配置 projects.roots 或 projects.list\n');
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });

function prompt() {
  if (process.stdin.isTTY) rl.setPrompt('你 > ');
  rl.prompt();
}

rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) return prompt();
  if (text === '/quit' || text === '/exit') {
    rl.close();
    return;
  }
  rl.pause();
  try {
    await bridge.handle(userId, text, { userId });
  } catch (err) {
    console.error(`❌ ${err.message}`);
  }
  // A turn can finish asynchronously (queued work), so wait for the bridge to
  // go idle before accepting the next line.
  while (bridge.running.has(userId) || bridge.queues.has(userId)) {
    await new Promise((r) => setTimeout(r, 200));
  }
  rl.resume();
  prompt();
});

rl.on('close', () => {
  console.log(`\n会话已保存到 ${path.relative(process.cwd(), config.stateFile)}`);
  process.exit(0);
});

prompt();
