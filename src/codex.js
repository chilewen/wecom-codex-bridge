import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AppServerUnavailableError, getAppServerRunner } from './appserver.js';
import { resolveCodexBin } from './bin-resolver.js';

const SESSION_ID_KEYS = ['thread_id', 'session_id', 'threadId', 'sessionId', 'conversation_id'];

function findSessionId(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return null;
  for (const key of SESSION_ID_KEYS) {
    if (typeof value[key] === 'string' && value[key]) return value[key];
  }
  for (const child of Object.values(value)) {
    const found = findSessionId(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function describeItem(item) {
  if (!item || typeof item !== 'object') return null;
  const type = item.type ?? '';
  if (type === 'command_execution' || type === 'command') {
    const cmd = item.command ?? item.command_line ?? '';
    return cmd ? `$ ${String(cmd).split('\n')[0]}` : null;
  }
  if (type === 'file_change' || type === 'patch_apply') {
    const files = (item.changes ?? item.files ?? [])
      .map((c) => c?.path ?? c?.file ?? c)
      .filter((f) => typeof f === 'string');
    return files.length ? `✎ ${files.join(', ')}` : null;
  }
  if (type === 'mcp_tool_call' || type === 'tool_call') {
    const name = item.name ?? item.tool ?? 'tool';
    return `⚙ ${name}`;
  }
  return null;
}

function extractAgentText(event) {
  const item = event?.item ?? event?.msg?.item;
  if (item && (item.type === 'agent_message' || item.type === 'assistant_message')) {
    if (typeof item.text === 'string') return item.text;
    const textParts = (item.content ?? [])
      .map((c) => (typeof c === 'string' ? c : c?.text))
      .filter(Boolean);
    if (textParts.length) return textParts.join('\n');
  }
  if (event?.type === 'agent_message' && typeof event.message === 'string') return event.message;
  return null;
}

/**
 * Pulls the human-readable reason out of a failure event. `codex exec --json`
 * reports provider/stream errors on stdout as a `turn.failed` (or `error`)
 * event; without this the caller only sees a bare exit code and a stderr tail
 * that usually contains nothing but "Reading prompt from stdin...".
 */
function extractErrorText(event) {
  const err = event?.error;
  if (typeof err === 'string' && err) return err;
  if (err && typeof err === 'object') {
    if (typeof err.message === 'string' && err.message) return err.message;
    try {
      const json = JSON.stringify(err);
      if (json && json !== '{}') return json;
    } catch {
      /* fall through */
    }
  }
  if (event?.type === 'error' && typeof event.message === 'string') return event.message;
  return null;
}

/**
 * Records the newest session for a cwd after `sinceMs`, by reading the rollout
 * files Codex writes into $CODEX_HOME/sessions. Used only as a fallback when the
 * JSON stream does not expose a session id.
 */
export function findLatestSessionForCwd(cwd, { codexHome, sinceMs, maxFiles = 400 } = {}) {
  const home = codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const sessionsRoot = path.join(home, 'sessions');
  if (!fs.existsSync(sessionsRoot)) return null;

  const files = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.endsWith('.jsonl')) {
        try {
          files.push({ full, mtime: fs.statSync(full).mtimeMs });
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(sessionsRoot, 0);

  files.sort((a, b) => b.mtime - a.mtime);
  for (const file of files.slice(0, maxFiles)) {
    if (sinceMs && file.mtime < sinceMs - 5000) break;
    const meta = readSessionMeta(file.full);
    if (meta?.cwd === cwd) return meta.sessionId;
  }
  return null;
}

// The session_meta line embeds the full system prompt, so it can reach tens of
// kilobytes. Read generously and fall back to a regex if JSON.parse trips over
// a torn line.
const META_READ_BYTES = 512 * 1024;

function readSessionMeta(file) {
  let firstLine;
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(META_READ_BYTES);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    firstLine = buf.subarray(0, read).toString('utf8').split('\n')[0];
  } catch {
    return null;
  }

  try {
    const payload = JSON.parse(firstLine)?.payload;
    return payload ? { cwd: payload.cwd, sessionId: payload.session_id ?? payload.id ?? null } : null;
  } catch {
    const cwdMatch = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(firstLine);
    const sessionMatch = /"session_id":"([0-9a-fA-F-]{8,})"/.exec(firstLine);
    if (!cwdMatch || !sessionMatch) return null;
    try {
      return { cwd: JSON.parse(`"${cwdMatch[1]}"`), sessionId: sessionMatch[1] };
    } catch {
      return null;
    }
  }
}

export function buildArgs({ config, cwd, sessionId, outputFile }) {
  const codex = config.codex;
  const args = ['exec'];

  if (sessionId) {
    // `codex exec resume` does not accept -C/-s/--color: the session carries them.
    args.push('resume', sessionId, '--json', '--skip-git-repo-check');
  } else {
    args.push('--json', '--color', 'never', '--skip-git-repo-check', '-C', cwd, '-s', codex.sandbox);
  }

  if (outputFile) args.push('-o', outputFile);
  if (codex.model) args.push('-m', codex.model);
  // `codex exec resume` rejects -C/-s but does accept -c, so this is safe on
  // both paths. Without it every run is sandboxed with network_access=false and
  // the model has to fall back to driving a browser to look anything up.
  if (codex.networkAccess) args.push('-c', 'sandbox_workspace_write.network_access=true');
  if (codex.bypassApprovalsAndSandbox) args.push('--dangerously-bypass-approvals-and-sandbox');
  args.push(...(codex.extraArgs ?? []));
  return args;
}

/**
 * Runs one Codex turn through the one-shot `codex exec` CLI.
 *
 * @returns {Promise<{sessionId: string|null, text: string, events: number, code: number}>}
 */
function runExec({ config, cwd, prompt, sessionId = null, onProgress, signal }) {
  const startedAt = Date.now();

  // Resolve before spawning so a missing CLI surfaces as actionable guidance
  // rather than a bare "spawn codex ENOENT".
  let bin;
  try {
    bin = resolveCodexBin(config).bin;
  } catch (err) {
    return Promise.reject(err);
  }

  const outputFile = path.join(
    os.tmpdir(),
    `codex-bridge-${process.pid}-${startedAt}-${Math.random().toString(36).slice(2, 8)}.txt`,
  );
  const args = buildArgs({ config, cwd, sessionId, outputFile });
  const childEnv = { ...process.env };
  if (config.codex.codexHome) childEnv.CODEX_HOME = config.codex.codexHome;

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let resolvedSessionId = sessionId;
    let lastAgentText = '';
    let streamError = '';
    let stderr = '';
    let eventCount = 0;
    let stdoutBuffer = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref?.();
    }, config.codex.timeoutMs);

    const onAbort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (data) => {
      stdoutBuffer += data.toString('utf8');
      let newlineIndex;
      while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (!line) continue;

        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        eventCount += 1;
        resolvedSessionId = findSessionId(event) ?? resolvedSessionId;
        streamError = extractErrorText(event) ?? streamError;

        const text = extractAgentText(event);
        if (text) lastAgentText = text;

        const progress = describeItem(event?.item);
        if (progress && config.codex.streamProgress) onProgress?.(progress);
      }
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString('utf8');
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`failed to launch ${bin}: ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);

      // Prefer the -o file when the JSON stream never carried an agent message.
      if (!lastAgentText) {
        try {
          lastAgentText = fs.readFileSync(outputFile, 'utf8').trim();
        } catch {
          /* ignore */
        }
      }
      try {
        fs.rmSync(outputFile, { force: true });
      } catch {
        /* ignore */
      }

      if (timedOut) {
        reject(new Error(`Codex timed out after ${config.codex.timeoutMs}ms`));
        return;
      }
      if (code === 0 || lastAgentText) {
        resolve({ sessionId: resolvedSessionId, text: lastAgentText, events: eventCount, code: code ?? 0 });
        return;
      }
      const detail = streamError || stderr.trim().slice(-2000) || '(no stderr output)';
      reject(new Error(`codex exec exited with code ${code}: ${detail}`));
    });

    child.stdin.on('error', () => {
      /* the child may exit before reading stdin */
    });
    child.stdin.end(prompt);
  });
}

/**
 * Runs one Codex turn.
 *
 * `transport: "app-server"` keeps a warm process alive and forwards
 * `item/agentMessage/delta` to `onDelta`, so the caller can stream text into
 * the chat. If the app-server cannot start at all we fall back to the one-shot
 * `codex exec` path; a turn that fails for model reasons is reported as-is
 * instead of being silently retried.
 *
 * @returns {Promise<{sessionId: string|null, text: string, events: number, code: number}>}
 */
export async function runCodex({
  config, cwd, prompt, sessionId = null, onProgress, onDelta, signal, logger = console,
}) {
  if ((config.codex.transport ?? 'exec') === 'app-server') {
    try {
      return await getAppServerRunner(config, logger).runTurn({
        cwd, prompt, sessionId, onDelta, signal,
      });
    } catch (err) {
      if (!(err instanceof AppServerUnavailableError)) throw err;
      logger.error?.(`[codex] app-server unavailable, falling back to codex exec: ${err.message}`);
    }
  }
  return runExec({ config, cwd, prompt, sessionId, onProgress, signal });
}
