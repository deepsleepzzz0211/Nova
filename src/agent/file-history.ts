import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { Message } from '../llm/types.js';
import { resolveToolPath } from '../shared/tool-args.js';

/**
 * Session file checkpoints (context-economics ticket 03, Claude Code-style).
 *
 * Before every successful `edit_file`/`write_file` the PRE-change content of
 * the target is snapshotted under `<historyDir>` (the CLI roots it at
 * `~/.nova/file-history/<sessionId>/`, so it migrates with NOVA_HOME and
 * survives --resume). `/undo` can then restore the files the undone turns
 * touched, sharing the same turn-boundary decision as the conversation
 * revert.
 *
 * Deliberately NOT git: no commits, no `.git` writes, no interference with
 * the user's own VCS state. Only the official write tools are tracked —
 * terminal/hand edits are detected at restore time (snapshot after-hash vs
 * current content) and such files are SKIPPED by default.
 */

/** Tools whose writes are checkpointed — derived from the registry's
 *  `fileAccess` capability by the loop, never a hardcoded name list. */
export type WriteToolNames = ReadonlySet<string>;

/** Default per-session snapshot cap (oldest evicted). */
export const DEFAULT_MAX_SNAPSHOTS = 100;

/** Conventional history directory: `<novaHome>/.nova/file-history/<sessionId>`. */
export function fileHistoryDir(home: string, sessionId: string): string {
  return path.join(home, '.nova', 'file-history', sessionId);
}

/** Result of a restore pass: absolute paths, in request order. */
export interface UndoReport {
  /** Files rolled back to their pre-turn content (or deleted if new). */
  restored: string[];
  /** Files left alone because they changed outside the session. */
  skipped: string[];
}

export interface FileHistoryDeps {
  /** Directory owning this session's snapshots + index. */
  historyDir: string;
  /** Snapshot cap; older entries are evicted with their payload files. */
  maxSnapshots?: number;
}

interface Entry {
  file: string;
  /** Snapshot payload file name; null when the file did not exist before. */
  snapshot: string | null;
  existsBefore: boolean;
  afterHash: string | null;
  /** True once the accompanying write SUCCEEDED (noteWritten). Restores
   *  only act on written entries — denied/failed calls leave files alone. */
  written: boolean;
}

interface IndexFile {
  nextSeq: number;
  entries: Entry[];
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Collect the files that successful write-tool calls touched in these
 * messages, resolved against `cwd` (the same basis the tools used).
 * `writeToolNames` comes from the registry's fileAccess capability.
 * Unparseable arguments are skipped — a checkpoint heuristic must never
 * throw inside a revert.
 */
export function collectTouchedWritePaths(
  messages: Message[],
  cwd: string,
  writeToolNames: WriteToolNames,
): string[] {
  const out: string[] = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !('tool_calls' in msg) || !msg.tool_calls) continue;
    for (const tc of msg.tool_calls) {
      if (!writeToolNames.has(tc.function.name)) continue;
      const resolved = resolveToolPath(tc.function.arguments, cwd);
      if (resolved !== null) out.push(resolved);
    }
  }
  return out;
}

export class FileHistory {
  private readonly historyDir: string;
  private readonly maxSnapshots: number;
  private readonly index: IndexFile;

  constructor(deps: FileHistoryDeps) {
    this.historyDir = deps.historyDir;
    this.maxSnapshots = deps.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS;
    this.index = this.loadIndex();
  }

  private get indexFile(): string {
    return path.join(this.historyDir, 'index.json');
  }

  private loadIndex(): IndexFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexFile, 'utf-8')) as Partial<IndexFile>;
      if (Array.isArray(raw.entries)) {
        const entries = raw.entries
          .filter((e): e is Entry => !!e && typeof e.file === 'string')
          .map((e) => ({ ...e, written: e.written === true }));
        return { nextSeq: raw.nextSeq ?? 1, entries };
      }
    } catch {
      // missing/corrupt index → fresh history (never block a turn)
    }
    return { nextSeq: 1, entries: [] };
  }

  private save(): void {
    fs.mkdirSync(this.historyDir, { recursive: true });
    fs.writeFileSync(this.indexFile, JSON.stringify(this.index, null, 2), 'utf-8');
  }

  private find(absolutePath: string): Entry | undefined {
    const abs = path.resolve(absolutePath);
    return this.index.entries.find((e) => e.file === abs);
  }

  /**
   * Capture the current content of `absolutePath` as its pre-change state.
   * Only the FIRST snapshot per file is kept — restoring therefore rolls
   * back to the state at the start of the turn group, not the last edit.
   */
  snapshotBefore(absolutePath: string): void {
    const abs = path.resolve(absolutePath);
    if (this.find(abs)) return;
    let content: Buffer | null = null;
    try {
      content = fs.readFileSync(abs);
    } catch {
      content = null; // file does not exist yet
    }
    let snapshotName: string | null = null;
    if (content !== null) {
      snapshotName = `snap-${this.index.nextSeq}.dat`;
      this.index.nextSeq++;
      fs.mkdirSync(this.historyDir, { recursive: true });
      fs.writeFileSync(path.join(this.historyDir, snapshotName), content);
    }
    this.index.entries.push({
      file: abs,
      snapshot: snapshotName,
      existsBefore: content !== null,
      afterHash: null,
      written: false,
    });
    while (this.index.entries.length > this.maxSnapshots) {
      const evicted = this.index.entries.shift();
      if (evicted?.snapshot) {
        try {
          fs.rmSync(path.join(this.historyDir, evicted.snapshot));
        } catch {
          // payload already gone
        }
      }
    }
    this.save();
  }

  /** Record the content the tools just wrote (external-change baseline). */
  noteWritten(absolutePath: string): void {
    const entry = this.find(absolutePath);
    if (!entry) return;
    entry.written = true;
    try {
      entry.afterHash = sha256(fs.readFileSync(path.resolve(absolutePath)));
    } catch {
      entry.afterHash = null;
    }
    this.save();
  }

  /** Number of tracked files (for tests/UI). */
  get size(): number {
    return this.index.entries.length;
  }

  /** Absolute paths with a usable checkpoint (write already succeeded). */
  trackedPaths(): Set<string> {
    return new Set(this.index.entries.filter((e) => e.written).map((e) => e.file));
  }

  /**
   * Roll the given files back to their pre-turn state. Files not tracked in
   * this session are ignored. With a changed after-write baseline (the user
   * edited or deleted the file outside the session) the file is SKIPPED
   * unless `force` is set.
   */
  restore(absolutePaths: string[], opts?: { force?: boolean }): UndoReport {
    const report: UndoReport = { restored: [], skipped: [] };
    for (const p of absolutePaths) {
      const abs = path.resolve(p);
      const entry = this.find(abs);
      if (!entry || !entry.written) continue;
      if (!opts?.force && entry.afterHash !== null) {
        let current: string | null = null;
        try {
          current = sha256(fs.readFileSync(abs));
        } catch {
          current = 'MISSING';
        }
        if (current !== entry.afterHash) {
          report.skipped.push(abs);
          continue;
        }
      }
      if (entry.existsBefore && entry.snapshot) {
        try {
          fs.copyFileSync(path.join(this.historyDir, entry.snapshot), abs);
        } catch {
          report.skipped.push(abs); // locked/busy target — keep the entry, retry later
          continue;
        }
      } else {
        try {
          fs.rmSync(abs, { force: true });
        } catch {
          report.skipped.push(abs);
          continue;
        }
      }
      // Consume the entry: a second undo of the same window must not
      // resurrect stale snapshots.
      const idx = this.index.entries.indexOf(entry);
      this.index.entries.splice(idx, 1);
      if (entry.snapshot) {
        try {
          fs.rmSync(path.join(this.historyDir, entry.snapshot));
        } catch {
          // payload already gone
        }
      }
      report.restored.push(abs);
    }
    if (report.restored.length > 0) this.save();
    return report;
  }
}
