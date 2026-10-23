import http from 'node:http';

import { loadConfig } from './config.js';
import { AppMessenger } from './wecom.js';
import { StateStore } from './sessions.js';
import { discoverProjects, describeProjectSource } from './projects.js';
import { Bridge } from './bot.js';
import { createRequestHandler } from './app.js';
import { resolveCodexBin } from './bin-resolver.js';
import { createWebhookTransport } from './transport.js';
import { warmUpAppServer } from './appserver.js';

const config = loadConfig(process.env.BRIDGE_CONFIG);

if (config.wecom.mode !== 'callback') {
  console.error(`wecom.mode is "${config.wecom.mode}", but this entry point serves the callback URL.`);
  console.error('Either set "wecom": { "mode": "callback" } or run `npm start` for the long connection.');
  process.exit(1);
}

const store = new StateStore(config.stateFile);
const projects = discoverProjects(config);
const messenger = config.wecom.replyMode === 'webhook' ? null : new AppMessenger(config.wecom.app);
const transport = createWebhookTransport({ config, messenger });
const bridge = new Bridge({ config, store, projects, transport });
const handler = createRequestHandler({ config, bridge, projects });

warmUpAppServer(config).catch((err) => {
  console.error(`[appserver] warmup failed (will retry on the first message): ${err.message}`);
});

const server = http.createServer(handler);

server.listen(config.server.port, config.server.host, () => {
  console.log('WeCom × Codex bridge is running');
  console.log(`  callback URL : http://${config.server.host}:${config.server.port}${config.server.path}`);
  console.log(`  reply mode   : ${config.wecom.replyMode}`);
  console.log(`  projects     : ${projects.length} discovered (${describeProjectSource(projects) || 'none'})`);
  console.log(`  network      : ${config.codex.networkAccess ? 'ON  (codex 可以联网)' : 'off (沙箱禁网)'}`);
  try {
    const resolved = resolveCodexBin(config);
    console.log(`  codex bin    : ${resolved.bin} (${resolved.source}; sandbox: ${config.codex.bypassApprovalsAndSandbox ? 'BYPASSED' : config.codex.sandbox})`);
  } catch (err) {
    console.error(`  codex bin    : NOT FOUND\n${err.message}\n`);
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
