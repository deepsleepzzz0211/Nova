import * as fs from 'fs';
import * as path from 'path';
import type { Message } from '../llm/types.js';

/**
 * JSONL-based conversation persistence (Codex "rollout" style).
 *
 * Every conversation message is appended as one JSON line, enabling exact
 * replay/resume of a session after a crash or explicit --resume.
 */
export class SessionStore {
  private readonly filePath: string;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(filePath: string) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  /** Create a store for a new session inside the given directory. */
  static create(dir: string, now = new Date()): SessionStore {
    const timestamp = now.toISOString().replace(/[:.]/g, '-');
    return new SessionStore(path.join(dir, `session-${timestamp}.jsonl`));
  }

  /** Append a message. Writes are chained to preserve ordering. */
  append(message: Message): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('SessionStore is closed.'));
    }
    this.queue = this.queue.then(() => {
      fs.appendFileSync(this.filePath, `${JSON.stringify(message)}\n`, 'utf-8');
    });
    return this.queue;
  }

  /** Flush pending writes. */
  async close(): Promise<void> {
    await this.queue;
    this.closed = true;
  }

  /** Load all messages from a session file. Malformed lines are skipped. */
  static load(filePath: string): Message[] {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return [];
    }

    const messages: Message[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        messages.push(JSON.parse(trimmed) as Message);
      } catch {
        // Skip malformed lines (e.g. partially written)
      }
    }
    return messages;
  }

  /** Return the most recently modified session file, or null. */
  static findLatest(dir: string): string | null {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }

    let latest: string | null = null;
    let latestMtime = -1;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const full = path.join(dir, entry.name);
      const mtime = fs.statSync(full).mtimeMs;
      if (mtime > latestMtime) {
        latestMtime = mtime;
        latest = full;
      }
    }
    return latest;
  }
}
