import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeAesKey } from './wecom-crypto.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULTS = {
  server: {
    host: '127.0.0.1',
    port: 8787,
    // Path must match the "URL" you register in the WeCom admin console.
    path: '/wecom/callback',
  },
  wecom: {
    // "longconn" = 智能机器人 API 模式长连接（推荐，无需公网地址）
    // "callback" = 自建应用 / 普通模式机器人的回调 URL
    mode: 'longconn',
    longconn: {
      wsUrl: 'wss://openws.work.weixin.qq.com',
      botId: '',
      secret: '',
      heartbeatMs: 30000,
    },
    // --- Callback (receiving messages) ---
    token: '',
    encodingAESKey: '',
    // 自建应用: your corpid. 智能机器人/群机器人: usually the corpid as well.
    corpId: '',
    // Override if the decrypted receiveId is something else (e.g. a suite id).
    receiveId: '',
    strictReceiveId: false,

    // --- Outbound (sending replies) ---
    // "webhook"  -> 群机器人 / 智能机器人 webhook URL (simplest, replies go to the group)
    // "app"      -> 自建应用 message/send API (replies go to the user directly, needs corpSecret)
    // "both"     -> webhook first, fall back to app API
    replyMode: 'webhook',
    webhookUrl: '',
    app: {
      corpId: '',
      corpSecret: '',
      agentId: '',
    },
  },
  codex: {
    bin: 'codex',
    // Leave empty to use the default ($CODEX_HOME or ~/.codex).
    codexHome: '',
    // read-only | workspace-write | danger-full-access
    sandbox: 'workspace-write',
    // Let sandboxed runs reach the network (adds
    // `-c sandbox_workspace_write.network_access=true` to every codex exec).
    // Off by default: with it on, a run that this bot triggers can fetch from
    // the internet. Lock down security.allowedUsers before enabling.
    networkAccess: false,
    model: '',
    // Transport for a turn:
    //   "app-server" - one warm process, streams agent-message deltas (default)
    //   "exec"       - one `codex exec` process per turn, only the final text
    transport: 'app-server',
    // Forward streamed text into the WeCom reply as it arrives.
    streamDeltas: true,
    // Optional reasoning effort override (low | medium | high). Empty = CLI default.
    reasoningEffort: '',
    // Extra CLI args appended to every `codex exec` call.
    extraArgs: [],
    timeoutMs: 30 * 60 * 1000,
    // Push a short line to WeCom whenever Codex runs a command / edits a file.
    // Off by default: those lines are noisy in a chat window. Turn it on when
    // you want to watch a long run from your phone.
    streamProgress: false,
    progressThrottleMs: 4000,
    // Push the "▶ 已收到 …" line the moment a run starts. It is the only
    // intermediate message left, and it doubles as a "still working" hint
    // because the same message is later replaced by the result.
    showAck: true,
    // While a run is in flight, refresh that same line with an elapsed timer
    // ("⏳ 正在处理… 3m12s"). Never adds messages - the result replaces it.
    // 0 disables it. Only applies when showAck is true.
    keepaliveMs: 60000,
    // DANGEROUS: skips approvals and sandboxing. Only for a throwaway VM/container.
    bypassApprovalsAndSandbox: false,
    // Where "无项目" mode (/none) runs Codex. Empty = <codexHome>/wecom-scratch.
    scratchDir: '',
  },
  projects: {
    // Where the project list comes from:
    //   "codex" - the Codex app's own project list, in sidebar order (default)
    //   "scan"  - walk `roots` looking for git repositories
    //   "both"  - Codex projects first, then anything else found on disk
    source: 'codex',
    // Override if the Codex state file lives somewhere else (default ~/.codex).
    codexStateFile: '',
    // Directories scanned (depth-limited) for git repositories to offer as projects.
    roots: [],
    // Explicit entries: [{ "name": "my-api", "path": "/abs/path" }]
    list: [],
    scanDepth: 3,
  },
  security: {
    // Empty array = allow everyone. Otherwise only these WeCom userids may use the bot.
    allowedUsers: [],
  },
  limits: {
    maxConcurrentRuns: 2,
    maxPromptChars: 8000,
  },
  stateFile: 'data/state.json',
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function mergeConfig(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      out[key] = mergeConfig(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * @param {string} [configPath]
 * @param {{ requireWecom?: boolean }} [options]
 *   requireWecom: false for local/offline modes (e.g. the terminal REPL) that
 *   never talk to WeCom, so unset WeCom credentials are not an error.
 */
export function loadConfig(configPath = path.join(ROOT, 'config.json'), { requireWecom = true } = {}) {
  let fileConfig = {};
  if (fs.existsSync(configPath)) {
    fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } else {
    console.warn(`[config] ${configPath} not found, using defaults (nothing will work until you create it)`);
  }
  const config = mergeConfig(DEFAULTS, fileConfig);

  if (process.env.WECOM_TOKEN) config.wecom.token = process.env.WECOM_TOKEN;
  if (process.env.WECOM_AES_KEY) config.wecom.encodingAESKey = process.env.WECOM_AES_KEY;
  if (process.env.WECOM_WEBHOOK_URL) config.wecom.webhookUrl = process.env.WECOM_WEBHOOK_URL;
  if (process.env.WECOM_BOT_ID) config.wecom.longconn.botId = process.env.WECOM_BOT_ID;
  if (process.env.WECOM_BOT_SECRET) config.wecom.longconn.secret = process.env.WECOM_BOT_SECRET;
  if (process.env.WECOM_MODE) config.wecom.mode = process.env.WECOM_MODE;
  if (process.env.CODEX_BIN) config.codex.bin = process.env.CODEX_BIN;
  if (process.env.PORT) config.server.port = Number(process.env.PORT);

  config.stateFile = path.isAbsolute(config.stateFile)
    ? config.stateFile
    : path.join(ROOT, config.stateFile);

  const home = process.env.HOME || os.homedir();
  const codexHome = config.codex.codexHome
    ? config.codex.codexHome.replace(/^~(?=\/|$)/, home)
    : path.join(home, '.codex');
  config.codex.codexHome = codexHome;
  config.codex.scratchDir = path.resolve(
    (config.codex.scratchDir || path.join(codexHome, 'wecom-scratch')).replace(/^~(?=\/|$)/, home),
  );

  validateConfig(config, { requireWecom });
  return config;
}

export function validateConfig(config, { requireWecom = true } = {}) {
  validateBaseConfig(config);
  if (requireWecom) validateWecomConfig(config);
}

function validateBaseConfig(config) {
  const problems = [];
  if (!config.codex?.bin) problems.push('codex.bin is empty');
  if (typeof config.codex?.networkAccess !== 'boolean') {
    problems.push('codex.networkAccess must be true or false');
  }
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(config.codex?.sandbox)) {
    problems.push(`codex.sandbox must be read-only|workspace-write|danger-full-access, got "${config.codex?.sandbox}"`);
  }
  if (!['codex', 'scan', 'both'].includes(config.projects?.source)) {
    problems.push(`projects.source must be codex|scan|both, got "${config.projects?.source}"`);
  }
  if (!Array.isArray(config.projects?.list)) problems.push('projects.list must be an array');
  if (!Array.isArray(config.projects?.roots)) problems.push('projects.roots must be an array');
  throwIfProblems(problems);
}

function validateWecomConfig(config) {
  if (config.wecom.mode === 'longconn') {
    validateLongConnConfig(config);
    return;
  }
  if (config.wecom.mode !== 'callback') {
    throw new Error(`Invalid config:\n  - wecom.mode must be longconn|callback, got "${config.wecom.mode}"`);
  }
  const problems = [];

  // Catch untouched config.example.json values first, so the error names the
  // real problem instead of a confusing length/signature failure later.
  const placeholders = [];
  if (config.wecom.token.includes('PASTE_')) placeholders.push('wecom.token');
  if (config.wecom.encodingAESKey.includes('PASTE_')) placeholders.push('wecom.encodingAESKey');
  if (String(config.wecom.webhookUrl).includes('PASTE_')) placeholders.push('wecom.webhookUrl');
  if (config.wecom.corpId.includes('0123456789abcdef')) placeholders.push('wecom.corpId');
  for (const key of ['corpId', 'corpSecret', 'agentId']) {
    if (String(config.wecom.app?.[key] ?? '').includes('PASTE_')) placeholders.push(`wecom.app.${key}`);
  }
  throwIfProblems(placeholders.map((p) => `${p} is still the example placeholder`));

  if (!config.wecom.token) problems.push('wecom.token is empty');
  if (!config.wecom.encodingAESKey) problems.push('wecom.encodingAESKey is empty');
  if (config.wecom.encodingAESKey && config.wecom.encodingAESKey.length !== 43) {
    problems.push(`wecom.encodingAESKey must be 43 chars, got ${config.wecom.encodingAESKey.length}`);
  } else if (config.wecom.encodingAESKey) {
    try {
      decodeAesKey(config.wecom.encodingAESKey);
    } catch (err) {
      problems.push(`wecom.encodingAESKey is not a valid Base64 key: ${err.message}`);
    }
  }
  if (config.wecom.replyMode !== 'webhook' && config.wecom.replyMode !== 'app' && config.wecom.replyMode !== 'both') {
    problems.push(`wecom.replyMode must be webhook|app|both, got "${config.wecom.replyMode}"`);
  }
  if (config.wecom.replyMode !== 'app' && !config.wecom.webhookUrl) {
    problems.push('wecom.webhookUrl is empty but replyMode needs it');
  }
  const needsApp = config.wecom.replyMode !== 'webhook';
  if (needsApp) {
    const app = config.wecom.app;
    if (!app.corpId || !app.corpSecret || !app.agentId) {
      problems.push('wecom.app.corpId/corpSecret/agentId are required for replyMode "app"/"both"');
    }
  }
  throwIfProblems(problems);
}

function throwIfProblems(problems) {
  if (problems.length) throw new Error(`Invalid config:\n  - ${problems.join('\n  - ')}`);
}

function validateLongConnConfig(config) {
  const lc = config.wecom.longconn ?? {};
  const problems = [];
  if (!lc.botId) problems.push('wecom.longconn.botId is empty');
  if (!lc.secret) problems.push('wecom.longconn.secret is empty');
  if (String(lc.botId).includes('PASTE_') || String(lc.secret).includes('PASTE_')) {
    problems.push('wecom.longconn.botId/secret are still the example placeholders');
  }
  if (!String(lc.wsUrl ?? '').startsWith('wss://')) {
    problems.push(`wecom.longconn.wsUrl must be a wss:// URL, got "${lc.wsUrl}"`);
  }
  throwIfProblems(problems);
}
