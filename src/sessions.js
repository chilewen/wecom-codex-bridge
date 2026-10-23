import fs from 'node:fs';
import path from 'node:path';

/**
 * Per-user conversation state, persisted as JSON so a restart does not lose
 * which project / Codex session each WeCom user was talking to.
 */
export class StateStore {
  constructor(file) {
    this.file = file;
    this.data = { users: {} };
    this.load();
  }

  load() {
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data.users ??= {};
    } catch {
      this.data = { users: {} };
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  getUser(userId) {
    this.data.users[userId] ??= {};
    return this.data.users[userId];
  }

  update(userId, patch) {
    const user = this.getUser(userId);
    Object.assign(user, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return user;
  }
}
