import fs from 'node:fs';
import path from 'node:path';

import { runCodex, findLatestSessionForCwd } from './codex.js';
import { describeProjectSource } from './projects.js';

/**
 * The acknowledgement line must distinguish "project" (sticky) from
 * "session" (per-conversation), otherwise every message looks like it starts
 * the same conversation over again.
 */
/** "45s" / "13m02s" / "1h05m" - compact enough to sit in a chat line. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  if (minutes) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function shorten(text, max = 40) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function describeAck({ label, projectPath, hasSession }) {
  const name = label ?? path.basename(projectPath);
  return `▶ 已收到 · ${name} · ${hasSession ? '继续会话' : '新会话'}`;
}

const HELP = `Codex 机器人使用说明

直接发消息 = 在工作目录里提问，Codex 会读代码/改代码后回复。

「工作目录」和「会话」是两件事：
  · 工作目录 = 代码在哪儿干活，选定后一直生效（可以是某个项目，也可以是「无项目」）
  · 会话 = 对话上下文，/new 或切换目录会重开

/projects  查看可选项目列表
/use <序号|名称>  切换项目
/none      切到「无项目」模式：不绑定任何仓库，在临时目录里干活
/p         查看当前工作目录
/new       开一个新会话（丢弃上下文）
/stop      中断正在执行的任务
/status    查看运行状态
/help      显示本说明

提示：切换目录后会自动开启新会话。`;

export class Bridge {
  /**
   * @param {object} opts
   * @param {{ send: Function, openStream: Function }} opts.transport
   */
  constructor({ config, store, projects, transport, logger = console }) {
    this.config = config;
    this.store = store;
    this.projects = projects;
    this.transport = transport;
    this.logger = logger;
    this.running = new Map(); // userId -> { abort, startedAt, prompt }
    this.queues = new Map(); // userId -> [{ prompt, ctx }]
  }

  send(ctx, text) {
    return this.transport.send(ctx, text);
  }

  isAllowed(userId) {
    const allowed = this.config.security.allowedUsers ?? [];
    return allowed.length === 0 || allowed.includes(userId);
  }

  resolveProject(userId) {
    const user = this.store.getUser(userId);
    if (user.project && this.projects.some((p) => p.path === user.project)) {
      return user.project;
    }
    return null;
  }

  /**
   * Where Codex should run: a discovered project, or the scratch directory when
   * the user asked for "无项目" mode. Returns null when nothing is chosen yet.
   */
  resolveWorkspace(userId) {
    const user = this.store.getUser(userId);
    if (user.scratch) {
      return { cwd: this.config.codex.scratchDir, label: '无项目', kind: 'scratch' };
    }
    const project = this.resolveProject(userId);
    if (!project) return null;
    return { cwd: project, label: path.basename(project), kind: 'project' };
  }

  async handle(userId, rawText, ctx = { userId }) {
    const text = String(rawText ?? '').trim();
    if (!text) return;

    if (!this.isAllowed(userId)) {
      await this.send(ctx, '你没有使用权限。请联系管理员把你的 userid 加入 config.json 的 security.allowedUsers。');
      return;
    }

    if (text.startsWith('/')) {
      await this.handleCommand(userId, text, ctx);
      return;
    }

    await this.enqueue(userId, text, ctx);
  }

  async handleCommand(userId, text, ctx) {
    const [rawCmd, ...rest] = text.split(/\s+/);
    const cmd = rawCmd.toLowerCase();
    const arg = rest.join(' ').trim();

    switch (cmd) {
      case '/help':
      case '/?':
        await this.send(ctx, HELP);
        return;

      case '/projects':
      case '/ls': {
        const list = this.projects.map((p, i) => `${i + 1}. ${p.name}\n   ${p.path}`).join('\n');
        const from = describeProjectSource(this.projects);
        await this.send(
          ctx,
          list
            ? `可选项目（共 ${this.projects.length} 个${from ? ` · ${from}` : ''}）：\n${list}\n\n发送「/use <序号或名称>」切换。`
            : '没有发现任何项目：检查 config.json 的 projects.source，或配 projects.list。',
        );
        return;
      }

      case '/use':
      case '/project': {
        if (!arg) {
          await this.send(ctx, '用法：/use <序号或名称>。先发 /projects 查看列表。');
          return;
        }
        const byIndex = /^\d+$/.test(arg) ? this.projects[Number(arg) - 1] : null;
        const byName = this.projects.find((p) => p.name === arg)
          ?? this.projects.find((p) => p.name.toLowerCase() === arg.toLowerCase())
          ?? this.projects.find((p) => p.path.endsWith(`/${arg}`));
        const target = byIndex ?? byName;
        if (!target) {
          await this.send(ctx, `找不到项目「${arg}」。发送 /projects 查看列表。`);
          return;
        }
        this.store.update(userId, { project: target.path, scratch: false, sessionId: null });
        await this.send(ctx, `已切换到项目：${target.name}\n${target.path}\n（已开启新会话）`);
        return;
      }

      case '/p':
      case '/current': {
        const workspace = this.resolveWorkspace(userId);
        const user = this.store.getUser(userId);
        await this.send(
          ctx,
          workspace
            ? `${workspace.kind === 'scratch' ? '当前：无项目' : `当前项目：${workspace.label}`}\n`
              + `${workspace.cwd}\n会话：${user.sessionId ?? '（未开始）'}`
            : '还没有选择工作目录。发送 /projects 查看，或 /none 用「无项目」模式。',
        );
        return;
      }

      case '/none':
      case '/scratch': {
        const dir = this.config.codex.scratchDir;
        this.store.update(userId, { project: null, scratch: true, sessionId: null });
        await this.send(
          ctx,
          `已切换到「无项目」模式，之前的会话上下文已清除。\n`
          + `Codex 会在一个不绑定仓库的目录里工作：\n${dir}\n\n`
          + `现在直接发消息就行；想回到某个项目发 /use <序号>。`,
        );
        return;
      }

      case '/new':
      case '/reset': {
        const workspace = this.resolveWorkspace(userId);
        this.store.update(userId, { sessionId: null });
        await this.send(
          ctx,
          `已开启新会话，之前的上下文已清除。\n工作目录不变，仍是：${workspace ? workspace.label : '（未选择）'}`,
        );
        return;
      }

      case '/stop':
      case '/cancel': {
        const state = this.running.get(userId);
        if (!state) {
          await this.send(ctx, '当前没有正在执行的任务。');
          return;
        }
        state.abort.abort();
        this.queues.delete(userId);
        await this.send(ctx, '已请求中断当前任务。');
        return;
      }

      case '/status': {
        const state = this.running.get(userId);
        const queued = this.queues.get(userId)?.length ?? 0;
        const workspace = this.resolveWorkspace(userId);
        await this.send(
          ctx,
          [
            `运行中：${state ? `是（${Math.round((Date.now() - state.startedAt) / 1000)}s）` : '否'}`,
            `排队中：${queued}`,
            `工作目录：${workspace ? `${workspace.label}（${workspace.cwd}）` : '（未选择）'}`,
            `全局并发：${this.running.size}/${this.config.limits.maxConcurrentRuns}`,
          ].join('\n'),
        );
        return;
      }

      default:
        await this.send(ctx, `未知命令 ${rawCmd}。发送 /help 查看用法。`);
    }
  }

  async enqueue(userId, prompt, ctx) {
    const existing = this.running.get(userId);
    if (existing) {
      const queue = this.queues.get(userId) ?? [];
      if (queue.length >= 3) {
        await this.send(ctx, '排队任务过多（上限 3 条），请等前面的处理完或发送 /stop。');
        return;
      }
      queue.push({ prompt, ctx });
      this.queues.set(userId, queue);
      await this.send(ctx, `上一条还在处理中，这条已排队（第 ${queue.length} 条）。`);
      return;
    }
    await this.runTurn(userId, prompt, ctx);
  }

  async runTurn(userId, prompt, ctx) {
    const workspace = this.resolveWorkspace(userId);
    if (!workspace) {
      await this.send(ctx, '请先选择工作目录：发送 /projects 挑一个项目，或发 /none 用「无项目」模式。');
      return;
    }
    if (this.running.size >= this.config.limits.maxConcurrentRuns) {
      await this.send(ctx, '机器人当前并发已满，请稍后再试。');
      return;
    }
    if (prompt.length > this.config.limits.maxPromptChars) {
      await this.send(ctx, `消息太长了（${prompt.length} 字符，上限 ${this.config.limits.maxPromptChars}）。请拆开发送。`);
      return;
    }

    const abort = new AbortController();
    const startedAt = Date.now();
    this.running.set(userId, { abort, startedAt, prompt });

    const user = this.store.getUser(userId);
    const stream = this.transport.openStream(ctx);
    const ack = describeAck({ label: workspace.label, hasSession: Boolean(user.sessionId) });
    if (this.config.codex.showAck) {
      await stream
        .push(`${ack}\n\n`)
        .catch((err) => this.logger.error(`[bridge] ack failed: ${err.message}`));
    }

    // A run can take many minutes. Without this the chat is silent and the log
    // says nothing, so "is it stuck?" is unanswerable. Re-pushing the ack line
    // with an elapsed timer updates the SAME message - no extra bubbles.
    const keepaliveMs = this.config.codex.showAck ? Number(this.config.codex.keepaliveMs) || 0 : 0;
    const keepaliveTimer = keepaliveMs > 0
      ? setInterval(() => {
        stream
          .push(`${ack}\n\n⏳ 正在处理… ${formatDuration(Date.now() - startedAt)}\n`)
          .catch(() => {});
      }, keepaliveMs)
      : null;
    keepaliveTimer?.unref?.();

    this.logger.log(
      `[bridge] run started · ${userId} · ${workspace.label} · "${shorten(prompt)}"`,
    );

    const onProgress = (line) => {
      stream.push(`\`${line}\`\n\n`).catch(() => {});
    };

    // app-server emits the answer as it is written. Push it into the same
    // streamed message so the chat fills in progressively instead of staying
    // silent until the whole turn finishes. The first delta makes the elapsed
    // "still working" banner redundant, so stop refreshing it.
    let firstDeltaAt = null;
    const onDelta = (delta) => {
      if (!this.config.codex.streamDeltas) return;
      if (firstDeltaAt === null) {
        firstDeltaAt = Date.now();
        clearInterval(keepaliveTimer);
        this.logger.log(
          `[bridge] first token · ${userId} · ${formatDuration(firstDeltaAt - startedAt)}`,
        );
      }
      stream.push(delta).catch(() => {});
    };

    // The scratch directory is created on demand; projects already exist.
    try {
      fs.mkdirSync(workspace.cwd, { recursive: true });
    } catch (err) {
      this.logger.error(`[bridge] could not create ${workspace.cwd}: ${err.message}`);
      await stream.finish(`❌ 无法创建工作目录 ${workspace.cwd}：${err.message}`).catch(() => {});
      clearInterval(keepaliveTimer);
      this.running.delete(userId);
      return;
    }

    try {
      const result = await runCodex({
        config: this.config,
        cwd: workspace.cwd,
        prompt,
        sessionId: user.sessionId,
        onProgress,
        onDelta,
        signal: abort.signal,
        logger: this.logger,
      });

      let sessionId = result.sessionId;
      if (!sessionId) {
        sessionId = findLatestSessionForCwd(workspace.cwd, { codexHome: this.config.codex.codexHome, sinceMs: startedAt });
      }
      if (sessionId) {
        this.store.update(userId, {
          sessionId,
          project: workspace.kind === 'project' ? workspace.cwd : null,
          scratch: workspace.kind === 'scratch',
        });
      }

      const elapsed = Date.now() - startedAt;
      this.logger.log(
        `[bridge] run finished · ${userId} · ${formatDuration(elapsed)} · `
        + `session ${sessionId ?? '(unknown)'} · ${result.events} events`,
      );
      await stream.finish(
        `${result.text || '(Codex 没有返回文本内容)'}\n\n---\n\`${workspace.label}\` · ${formatDuration(elapsed)}`,
      );
    } catch (err) {
      const aborted = abort.signal.aborted;
      this.logger.error(
        `[bridge] run ${aborted ? 'aborted' : 'failed'} · ${userId} · `
        + `${formatDuration(Date.now() - startedAt)} · ${err.message}`,
      );
      await stream
        .finish(aborted ? '⏹ 任务已中断。' : `❌ 执行失败：${err.message}`)
        .catch(() => {});
    } finally {
      clearInterval(keepaliveTimer);
      this.running.delete(userId);
      const queue = this.queues.get(userId);
      if (queue?.length) {
        const next = queue.shift();
        if (queue.length === 0) this.queues.delete(userId);
        else this.queues.set(userId, queue);
        this.runTurn(userId, next.prompt, next.ctx).catch((err) => this.logger.error(`[bridge] queued run failed: ${err.message}`));
      }
    }
  }
}
