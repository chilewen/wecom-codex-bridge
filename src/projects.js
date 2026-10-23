import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where the project list comes from.
 *
 *   codex (default) - the Codex app's own project list, in sidebar order
 *   scan            - walk `projects.roots` looking for git repositories
 *   both            - Codex projects first, then anything else found on disk
 *
 * The Codex app keeps its list in `~/.codex/.codex-global-state.json`:
 *   local-projects : { <id>: { id, name, rootPaths: [abs...] } }
 *   project-order  : [ <id>... ]   <- the order the user sees in the sidebar
 * Reading it means `/projects` numbers match what the user sees in Codex.
 */
export const CODEX_STATE_FILE = '.codex-global-state.json';

function expandHome(value) {
  return String(value).replace(/^~(?=\/|$)/, process.env.HOME || os.homedir());
}

function isGitRepo(dir) {
  try {
    return fs.statSync(path.join(dir, '.git')).isDirectory()
      || fs.statSync(path.join(dir, '.git')).isFile();
  } catch {
    return false;
  }
}

function walk(dir, depth, maxDepth, found, seen) {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const child = path.join(dir, entry.name);
    if (seen.has(child)) continue;
    seen.add(child);
    if (isGitRepo(child)) {
      found.push({ name: entry.name, path: child });
      // Do not descend into a repo: nested repos are rarely what you want first.
      continue;
    }
    walk(child, depth + 1, maxDepth, found, seen);
  }
}

/**
 * Reads the Codex app's project list.
 * @param {{ stateFile?: string, codexHome?: string, onlyExisting?: boolean }} [opts]
 */
export function readCodexProjects({ stateFile, codexHome, onlyExisting = true } = {}) {
  const file = stateFile
    ? path.resolve(expandHome(stateFile))
    : path.join(expandHome(codexHome || path.join(process.env.HOME || os.homedir(), '.codex')), CODEX_STATE_FILE);

  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }

  const byId = state?.['local-projects'];
  if (!byId || typeof byId !== 'object') return [];

  // Sidebar order first; any project missing from project-order is appended.
  const order = Array.isArray(state['project-order']) ? state['project-order'] : [];
  const ids = [
    ...order.filter((id) => byId[id]),
    ...Object.keys(byId).filter((id) => !order.includes(id)),
  ];

  const projects = [];
  for (const id of ids) {
    const entry = byId[id] ?? {};
    const roots = (Array.isArray(entry.rootPaths) ? entry.rootPaths : []).filter(Boolean);
    const root = roots[0] ? path.resolve(expandHome(roots[0])) : null;
    if (!root) continue;
    if (onlyExisting && !fs.existsSync(root)) continue;
    projects.push({
      id,
      name: entry.name || path.basename(root),
      path: root,
      roots,
      source: 'codex',
    });
  }
  return projects;
}

/** Human-readable summary of where the current list came from. */
export function describeProjectSource(projects) {
  const sources = new Set(projects.map((p) => p.source).filter(Boolean));
  if (sources.size === 0) return '';
  if (sources.size > 1) return 'Codex 项目列表 + 扫描目录';
  const [only] = sources;
  if (only === 'codex') return 'Codex 项目列表';
  if (only === 'scan') return '扫描目录';
  return 'config.json';
}

function scanRoots(config) {
  const found = [];
  const seen = new Set();
  for (const root of config.projects?.roots ?? []) {
    const absRoot = path.resolve(expandHome(root));
    if (!fs.existsSync(absRoot)) continue;
    found.push({ name: path.basename(absRoot), path: absRoot });
    walk(absRoot, 1, Number(config.projects.scanDepth) || 3, found, seen);
  }
  return found;
}

/**
 * Returns the merged, de-duplicated project list in display order:
 * explicit `projects.list` entries, then Codex projects in sidebar order,
 * then scanned repositories.
 */
export function discoverProjects(config) {
  const settings = config.projects ?? {};
  const source = ['codex', 'scan', 'both'].includes(settings.source) ? settings.source : 'codex';

  const ordered = [];
  const seenPaths = new Set();
  const push = (entry) => {
    if (!entry?.path || seenPaths.has(entry.path)) return;
    seenPaths.add(entry.path);
    ordered.push(entry);
  };

  for (const entry of settings.list ?? []) {
    const abs = path.resolve(expandHome(entry.path));
    push({ name: entry.name || path.basename(abs), path: abs, explicit: true, source: 'config' });
  }

  if (source !== 'scan') {
    for (const entry of readCodexProjects({
      stateFile: settings.codexStateFile,
      codexHome: config.codex?.codexHome,
    })) {
      push(entry);
    }
  }

  // Scan when asked to, and also as a fallback so an empty list is never the
  // answer just because the Codex state file could not be read.
  const wantScan = source === 'scan' || source === 'both' || ordered.length === 0;
  if (wantScan) {
    for (const entry of scanRoots(config).sort((a, b) => a.path.localeCompare(b.path))) {
      push({ ...entry, explicit: false, source: 'scan' });
    }
  }

  return ordered;
}
