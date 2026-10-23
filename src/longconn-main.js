/**
 * Entry point for the recommended mode: 智能机器人 API 模式 + 长连接.
 *
 * No public URL, no tunnel, no AES handling - the process dials out to
 * wss://openws.work.weixin.qq.com and subscribes with BotID + Secret.
 */
import { loadConfig } from './config.js';
import { StateStore } from './sessions.js';
import { discoverProjects, describeProjectSource } from './projects.js';
import { Bridge } from './bot.js';
import { LongConnClient } from './longconn.js';
import { attachLongConnBot } from './longconn-bot.js';
import { createLongConnTransport } from './transport.js';
import { resolveCodexBin } from './bin-resolver.js';
import { warmUpAppServer } from './appserver.js';

const config = loadConfig(process.env.BRIDGE_CONFIG);

if (config.wecom.mode !== 'longconn') {
  console.error(`wecom.mode is "${config.wecom.mode}", but this entry point runs the long connection.`);
  console.error('Either set "wecom": { "mode": "longconn" } or run `npm run start:callback`.');
  process.exit(1);
}

const store = new StateStore(config.stateFile);
const projects = discoverProjects(config);
const client = new LongConnClient({
  botId: config.wecom.longconn.botId,
  secret: config.wecom.longconn.secret,
  wsUrl: config.wecom.longconn.wsUrl,
  heartbeatMs: config.wecom.longconn.heartbeatMs,
});
const transport = createLongConnTransport({ client });
const bridge = new Bridge({ config, store, projects, transport });

attachLongConnBot({ client, bridge, transport });

client.on('ready', () => {
  console.log(
    `[bot] ready · ${projects.length} projects · sandbox ${config.codex.sandbox}` +
      (config.codex.networkAccess ? ' · network on' : ' · network off'),
  );
});

client.on('replaced', () => {
  console.error('[bot] another process connected with this BotID and took over. Stopping.');
  console.error('[bot] check that only one copy of this bridge is running.');
});

console.log('WeCom long-connection × Codex bridge');
console.log(`  ws url    : ${config.wecom.longconn.wsUrl}`);
console.log(`  bot id    : ${config.wecom.longconn.botId.slice(0, 8)}…`);
console.log(`  projects  : ${projects.length} discovered (${describeProjectSource(projects) || 'none'})`);
try {
  const resolved = resolveCodexBin(config);
  console.log(`  codex bin : ${resolved.bin} (${resolved.source})`);
} catch (err) {
  console.error(`  codex bin : NOT FOUND\n${err.message}`);
}
console.log(`  network   : ${config.codex.networkAccess ? 'ON  (codex 可以联网)' : 'off (沙箱禁网)'}`);

// Pay app-server startup while WeCom is still connecting, so the first user
// message does not pay it too (the model's first token still dominates).
warmUpAppServer(config).catch((err) => {
  console.error(`[appserver] warmup failed (will retry on the first message): ${err.message}`);
});

client.connect();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n${signal} received, closing connection`);
    client.close();
    setTimeout(() => process.exit(0), 500).unref();
  });
}
