import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `codex` is often not on PATH for a plain terminal or a launchd job even when
 * it starts fine for an interactive Codex session, because the desktop app
 * injects its own PATH into its child processes. Resolve it explicitly instead
 * of relying on that luck.
 */
export const CODEX_CANDIDATES = [
  // ChatGPT desktop bundles the CLI under codex-cli/ (app >= 0.159).
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  // Older bundles shipped a bare binary at Resources/codex.
  '/Applications/ChatGPT.app/Contents/Resources/codex',
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
  path.join(os.homedir(), '.local/bin/codex'),
  path.join(os.homedir(), '.npm-global/bin/codex'),
  path.join(os.homedir(), 'bin/codex'),
];

function isExecutable(file) {
  try {
    return fs.statSync(file).isFile() && Boolean(fs.accessSync(file, fs.constants.X_OK) ?? true);
  } catch {
    return false;
  }
}

/** Minimal `which`: scans PATH without shelling out. */
export function which(name, env = process.env) {
  if (!name) return null;
  if (name.includes(path.sep)) return isExecutable(name) ? name : null;
  const dirs = String(env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const full = path.join(dir, name);
    if (isExecutable(full)) return full;
  }
  return null;
}

const cache = new Map();

/**
 * @returns {{ bin: string, source: 'configured' | 'path' | 'candidate', tried: string[] }}
 * @throws when nothing runnable can be found
 */
export function resolveCodexBin(config, env = process.env) {
  const configured = String(config?.codex?.bin ?? '').trim() || 'codex';
  const key = `${configured}\u0000${env.PATH ?? ''}`;
  const cached = cache.get(key);
  // Re-check the cached path: the ChatGPT app replaces its Resources tree on
  // update, so a long-running bridge can hold a path that no longer exists.
  if (cached) {
    if (isExecutable(cached.bin)) return cached;
    cache.delete(key);
  }

  const tried = [];

  if (configured.includes('/')) {
    if (isExecutable(configured)) {
      const result = { bin: configured, source: 'configured', tried };
      cache.set(key, result);
      return result;
    }
    tried.push(configured);
    throw new Error(buildError(`codex.bin is set to "${configured}" but that file is not executable`, tried, configured));
  }

  const onPath = which(configured, env);
  if (onPath) {
    const result = { bin: onPath, source: 'path', tried };
    cache.set(key, result);
    return result;
  }
  tried.push(`PATH lookup for "${configured}"`);

  for (const candidate of CODEX_CANDIDATES) {
    tried.push(candidate);
    if (isExecutable(candidate)) {
      const result = { bin: candidate, source: 'candidate', tried };
      cache.set(key, result);
      return result;
    }
  }

  throw new Error(buildError(`could not find a runnable "${configured}"`, tried, configured));
}

function buildError(headline, tried, configured) {
  return [
    headline,
    '',
    'Tried:',
    ...tried.map((t) => `  - ${t}`),
    '',
    'Fix it by either:',
    '  1. installing the CLI:  npm i -g @openai/codex',
    `  2. or pointing config.json at the binary you already have:`,
    `       "codex": { "bin": "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex" }`,
    '',
    `(current value of codex.bin: "${configured}")`,
  ].join('\n');
}
