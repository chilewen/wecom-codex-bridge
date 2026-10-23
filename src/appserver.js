import { spawn } from 'node:child_process';
import readline from 'node:readline';

import { resolveCodexBin } from './bin-resolver.js';

const CONTROL_TIMEOUT_MS = 30_000;
const MAX_STDERR = 20_000;

/**
 * Raised when the app-server cannot be started or speaks no protocol.
 * Callers use this to fall back to the one-shot `codex exec` path; ordinary
 * turn failures (model errors, interrupted turns) are NOT this type.
 */
export class AppServerUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AppServerUnavailableError';
  }
}

function requestKey(id) {
  return String(id);
}

class AppServerClient {
  constructor({ bin, codexHome, logger }) {
    this.bin = bin;
    this.logger = logger;
    this.spawnedAt = Date.now();
    this.pending = new Map();
    this.turns = new Map();
    this.nextId = 1;
    this.dead = false;
    this.stderr = '';

    const env = { ...process.env };
    if (codexHome) env.CODEX_HOME = codexHome;

    this.child = spawn(bin, ['app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdin.on('error', () => {});
    this.child.stderr.on('data', (data) => {
      this.stderr += data.toString('utf8');
      if (this.stderr.length > MAX_STDERR) this.stderr = this.stderr.slice(-MAX_STDERR);
    });
    this.child.on('error', (err) => this.markDead(`failed to launch ${bin}: ${err.message}`));
    this.child.on('exit', (code, sig) => this.markDead(`app-server exited (code ${code ?? 'null'}, signal ${sig ?? 'none'})`));

    this.rl = readline.createInterface({ input: this.child.stdout });
    this.rl.on('line', (line) => this.onLine(line));

    const ready = this.request('initialize', {
      clientInfo: { name: 'wecom-codex-bridge', title: 'WeCom Codex Bridge', version: '0.1.0' },
      capabilities: null,
    }, CONTROL_TIMEOUT_MS).then((result) => {
      this.logger?.log?.(`[appserver] ready in ${Date.now() - this.spawnedAt}ms (pid ${this.child.pid})`);
      return result;
    }).catch((err) => {
      this.markDead(err.message);
      throw new AppServerUnavailableError(err.message);
    });
    // Keep a rejection observer so a failed start cannot crash the bridge as an
    // unhandled rejection before the first turn awaits `ready`.
    ready.catch(() => {});
    this.ready = ready;
  }

  write(message) {
    if (this.dead) return;
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (err) {
      this.markDead(`app-server stdin write failed: ${err.message}`);
    }
  }

  request(method, params, timeoutMs = CONTROL_TIMEOUT_MS) {
    if (this.dead) {
      return Promise.reject(new AppServerUnavailableError(`app-server is not running (${this.stderr.trim().slice(-500)})`));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestKey(id));
        reject(new AppServerUnavailableError(`app-server ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(requestKey(id), { resolve, reject, timer, method });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  onLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    // Server -> client request (approvals and similar). We run with
    // approvalPolicy "never", so refusing is consistent with exec mode.
    if (msg.method && msg.id !== undefined) {
      this.write({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `unsupported by bridge: ${msg.method}` },
      });
      return;
    }

    if (msg.method) {
      this.onNotification(msg.method, msg.params ?? {});
      return;
    }

    const pending = this.pending.get(requestKey(msg.id));
    if (!pending) return;
    this.pending.delete(requestKey(msg.id));
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(new Error(`app-server ${pending.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  onNotification(method, params) {
    const state = params.threadId ? this.turns.get(params.threadId) : null;
    if (!state) return;
    state.events += 1;

    if (method === 'item/agentMessage/delta') {
      const delta = params.delta ?? '';
      if (!delta) return;
      state.deltaText += delta;
      try {
        state.onDelta?.(delta);
      } catch (err) {
        this.logger?.error?.(`[appserver] onDelta threw: ${err.message}`);
      }
      return;
    }

    if (method === 'item/completed' && params.item?.type === 'agentMessage') {
      state.finalText = params.item.text ?? state.finalText;
      return;
    }

    if (method === 'turn/completed') {
      this.settle(state, params.turn ?? {});
    }
  }

  settle(state, turn) {
    if (state.settled) return;
    state.settled = true;
    state.events += 1;
    clearTimeout(state.timer);
    if (state.signal) state.signal.removeEventListener('abort', state.onAbort);
    if (this.turns.get(state.threadId) === state) this.turns.delete(state.threadId);

    const status = turn.status ?? 'failed';
    if (status === 'completed') {
      state.resolve({
        sessionId: state.threadId,
        text: (state.finalText ?? state.deltaText).trim(),
        events: state.events,
        code: 0,
      });
      return;
    }
    if (status === 'interrupted') {
      const err = new Error('Codex interrupted');
      err.code = 'INTERRUPTED';
      state.reject(err);
      return;
    }
    const message = turn.error?.message || `turn ended with status ${status}`;
    const err = new Error(message);
    err.code = 'TURN_FAILED';
    state.reject(err);
  }

  interrupt(state) {
    if (state.settled) return;
    if (!state.turnId) {
      state.interruptPending = true;
      return;
    }
    this.request('turn/interrupt', { threadId: state.threadId, turnId: state.turnId }, CONTROL_TIMEOUT_MS)
      .catch((err) => this.logger?.error?.(`[appserver] interrupt failed: ${err.message}`));
  }

  runTurn({ threadId, prompt, model, effort, onDelta, signal, timeoutMs }) {
    return new Promise((resolve, reject) => {
      const state = {
        threadId,
        onDelta,
        events: 0,
        deltaText: '',
        finalText: '',
        turnId: null,
        settled: false,
        interruptPending: false,
        resolve,
        reject,
        timer: null,
        signal,
        onAbort: null,
      };

      if (this.dead) {
        reject(new AppServerUnavailableError('app-server is not running'));
        return;
      }
      if (this.turns.has(threadId)) {
        reject(new Error('this thread already has a turn in flight'));
        return;
      }
      this.turns.set(threadId, state);

      state.timer = setTimeout(() => {
        this.logger?.error?.(`[appserver] turn timed out after ${timeoutMs}ms, interrupting`);
        this.interrupt(state);
        const err = new Error(`Codex timed out after ${timeoutMs}ms`);
        err.code = 'TIMEOUT';
        this.settleWithError(state, err);
      }, timeoutMs);
      state.timer.unref?.();

      if (signal) {
        state.onAbort = () => this.interrupt(state);
        if (signal.aborted) state.onAbort();
        else signal.addEventListener('abort', state.onAbort, { once: true });
      }

      const params = {
        threadId,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
      };
      if (model) params.model = model;
      if (effort) params.effort = effort;

      this.request('turn/start', params, CONTROL_TIMEOUT_MS).then((res) => {
        state.turnId = res?.turn?.id ?? null;
        if (state.interruptPending && !state.settled) this.interrupt(state);
      }, (err) => {
        if (err instanceof AppServerUnavailableError) {
          this.settleWithError(state, err);
        } else {
          this.settleWithError(state, new Error(`could not start turn: ${err.message}`));
        }
      });
    });
  }

  settleWithError(state, err) {
    if (state.settled) return;
    state.settled = true;
    clearTimeout(state.timer);
    if (state.signal) state.signal.removeEventListener('abort', state.onAbort);
    if (this.turns.get(state.threadId) === state) this.turns.delete(state.threadId);
    state.reject(err);
  }

  markDead(reason) {
    if (this.dead) return;
    this.dead = true;
    const err = new AppServerUnavailableError(reason);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
    for (const state of [...this.turns.values()]) this.settleWithError(state, err);
  }

  stop() {
    if (this.dead) return;
    this.markDead('app-server stopped');
    try {
      this.child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
}

/**
 * Keeps one app-server process alive for the bridge and runs turns over
 * JSON-RPC. This is what makes streaming possible: `codex exec --json` only
 * emits a finished agent message, while app-server pushes
 * `item/agentMessage/delta` as the model writes.
 */
export class AppServerRunner {
  constructor({ config, logger = console }) {
    this.config = config;
    this.logger = logger;
    this.client = null;

    this.sandbox = config.codex.bypassApprovalsAndSandbox
      ? 'danger-full-access'
      : config.codex.sandbox;
    this.approvalPolicy = 'never';
    this.threadConfig = {};
    if (config.codex.networkAccess) {
      this.threadConfig.sandbox_workspace_write = { network_access: true };
    }
  }

  ensureClient() {
    if (this.client && !this.client.dead) return this.client;
    const { bin } = resolveCodexBin(this.config);
    this.client = new AppServerClient({
      bin,
      codexHome: this.config.codex.codexHome,
      logger: this.logger,
    });
    return this.client;
  }

  async runTurn({ cwd, prompt, sessionId, onDelta, signal, timeoutMs }) {
    const client = this.ensureClient();
    await client.ready;

    let threadId = sessionId;
    if (threadId) {
      const resumeStartedAt = Date.now();
      try {
        await client.request('thread/resume', {
          threadId,
          cwd,
          approvalPolicy: this.approvalPolicy,
          sandbox: this.sandbox,
          config: this.threadConfig,
        });
        this.logger?.log?.(`[appserver] resumed thread ${threadId} in ${Date.now() - resumeStartedAt}ms`);
      } catch (err) {
        this.logger?.error?.(`[appserver] could not resume ${threadId}: ${err.message}; starting a new thread`);
        threadId = null;
      }
    }

    if (!threadId) {
      const startedAt = Date.now();
      const started = await client.request('thread/start', {
        cwd,
        approvalPolicy: this.approvalPolicy,
        sandbox: this.sandbox,
        config: this.threadConfig,
      });
      threadId = started?.thread?.id;
      if (!threadId) throw new Error('app-server did not return a thread id');
      this.logger?.log?.(`[appserver] started thread ${threadId} in ${Date.now() - startedAt}ms`);
    }

    return client.runTurn({
      threadId,
      prompt,
      model: this.config.codex.model || null,
      effort: this.config.codex.reasoningEffort || null,
      onDelta,
      signal,
      timeoutMs: timeoutMs ?? this.config.codex.timeoutMs,
    });
  }

  /**
   * Pay the process-spawn and protocol-handshake cost at bridge startup instead
   * of on the first user message. This is small (~100ms) but it also lets the
   * app-server load plugins/skills while the WeCom connection is still linking.
   */
  async warmup() {
    const client = this.ensureClient();
    await client.ready;
    return Date.now() - client.spawnedAt;
  }

  stop() {
    this.client?.stop();
    this.client = null;
  }
}

const runners = new Map();

function runnerKey(config) {
  return [config.codex.bin, config.codex.codexHome, config.codex.sandbox,
    config.codex.networkAccess, config.codex.bypassApprovalsAndSandbox].join('\u0000');
}

export function getAppServerRunner(config, logger = console) {
  const key = runnerKey(config);
  let runner = runners.get(key);
  if (!runner) {
    runner = new AppServerRunner({ config, logger });
    runners.set(key, runner);
  }
  return runner;
}

/**
 * Starts the app-server ahead of the first turn. No-ops for `exec` mode. Start
 * failures are propagated so callers can log them; the next real turn retries
 * lazily, so a failed warmup does not take the bridge down.
 */
export async function warmUpAppServer(config, logger = console) {
  if ((config.codex.transport ?? 'exec') !== 'app-server') return null;
  const startedAt = Date.now();
  const runner = getAppServerRunner(config, logger);
  await runner.warmup();
  const elapsed = Date.now() - startedAt;
  logger.log?.(`[appserver] warmup complete in ${elapsed}ms; first message skips process startup`);
  return elapsed;
}

export function stopAppServers() {
  for (const runner of runners.values()) runner.stop();
  runners.clear();
}

process.once('exit', stopAppServers);
