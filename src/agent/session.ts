import * as fs from 'fs';
import * as path from 'path';
import type { Message } from '../llm/types.js';

/** Digest of one stored session (for lists/pickers). */
export interface SessionSummary {
  file: string;
  mtimeMs: number;
  messageCount: number;
  /** First user message, truncated to 60 chars. */
  preview: string;
}

/** Compaction checkpoint entry persisted to the session log. */
export interface CompactionEntry {
  type: 'compaction';
  /** Full post-compaction message state (summary + kept messages). */
  messages: Message[];
}

/**
 * JSONL-based conversation persistence (Codex "rollout" style).
 *
 * Every conversation message is appended as one JSON line, enabling exact
 * replay/resume of a session after a crash or explicit --resume. Compaction
 * checkpoints are appended as typed entries: on replay they replace the
 * accumulated history with the post-compaction snapshot, so a resumed
 * session keeps its compacted (slim) context instead of blowing back up to
 * the full original history.
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

  /**
   * Persist a compaction checkpoint: the full post-compaction message
   * state. On replay this replaces the accumulated history, keeping the
   * resumed session slim (see class docs).
   */
  appendCompaction(messages: Message[]): Promise<void> {
    const entry: CompactionEntry = { type: 'compaction', messages };
    return this.append(entry as unknown as Message);
  }

  /** Flush pending writes. */
  async close(): Promise<void> {
    await this.queue;
    this.closed = true;
  }

  /** Load all messages from a session file, replaying compaction
   *  checkpoints. Malformed lines are skipped. */
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
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue; // Skip malformed lines (e.g. partially written)
      }
      const entry = parsed as { type?: string; messages?: unknown };
      if (entry?.type === 'compaction') {
        // Checkpoint: replace the accumulated history with the snapshot.
        if (Array.isArray(entry.messages)) {
          messages.length = 0;
          messages.push(...(entry.messages as Message[]));
        }
        continue;
      }
      messages.push(parsed as Message);
    }
    return messages;
  }

  /** Return the most recently modified session file, or null. */
  static findLatest(dir: string): string | null {
    const list = SessionStore.listSummaries(dir);
    return list.length > 0 ? list[0].file : null;
  }

  /**
   * Summaries of every session in a directory, newest first: file path,
   * message count, and a preview of the first user message (truncated to
   * 60 chars; system/skill messages do not count as the preview).
   */
  static listSummaries(dir: string): SessionSummary[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const summaries: SessionSummary[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const full = path.join(dir, entry.name);
      let mtimeMs = 0;
      let messages: Message[] = [];
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
        messages = SessionStore.load(full);
      } catch {
        continue;
      }
      const firstUser = messages.find(
        (m) => m.role === 'user' && typeof m.content === 'string' && m.content.length > 0,
      );
      const preview = typeof firstUser?.content === 'string'
        ? firstUser.content.slice(0, 60)
        : '(no user messages)';
      summaries.push({ file: full, mtimeMs, messageCount: messages.length, preview });
    }
    return summaries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }
}
