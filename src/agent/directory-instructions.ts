import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Lazy per-directory instruction files (context-economics ticket 02).
 *
 * Monorepos want rules that apply to a package, not the whole tree. When the
 * model touches a file, every AGENTS.md (CLAUDE.md fallback) on that file's
 * directory chain — up to but EXCLUDING the project root (already loaded as
 * project instructions) — is collected once, shallow-first, and handed to the
 * loop for append-only injection. A total byte budget (Codex-style
 * project_doc_max_bytes, default 32 KiB) keeps the context safe: the file
 * crossing the limit truncates with an explicit marker, deeper files then drop
 * with a note.
 */

export interface DirectoryInstructionsDeps {
  rootDir: string;
  /** Total injected-bytes ceiling across the whole session. Default 32 KiB. */
  maxTotalBytes?: number;
  /** Candidate file names, first hit wins per directory. */
  names?: string[];
}

export interface PendingInstruction {
  file: string;
  content: string;
}

const DEFAULT_NAMES = ['AGENTS.md', 'CLAUDE.md'];
const DEFAULT_BUDGET = 32 * 1024;

export class DirectoryInstructions {
  private readonly rootDir: string;
  private readonly budget: number;
  private readonly names: string[];
  private readonly visitedDirs = new Set<string>();
  private usedBytes = 0;

  constructor(deps: DirectoryInstructionsDeps) {
    this.rootDir = path.resolve(deps.rootDir);
    this.budget = deps.maxTotalBytes ?? DEFAULT_BUDGET;
    this.names = deps.names ?? DEFAULT_NAMES;
  }

  /** Instruction files newly relevant to this file path (may be empty). */
  pendingFor(absoluteFilePath: string): PendingInstruction[] {
    const chain = this.directoryChain(absoluteFilePath);
    const out: PendingInstruction[] = [];
    for (const dir of chain) {
      if (this.visitedDirs.has(dir)) continue;
      this.visitedDirs.add(dir);
      const found = this.findInstructionFile(dir);
      if (found === null) continue;
      let text: string;
      try {
        text = fs.readFileSync(found, 'utf-8');
      } catch {
        continue; // unreadable — skip, never break the turn
      }
      if (text.trim().length === 0) continue;
      // The budget is a HARD cap on injected bytes: the truncation marker
      // is reserved out of the remaining space before clipping, so content
      // + marker never exceeds it (review fix — the marker used to ride on
      // top of the cap).
      const MARKER_RESERVE = 96;
      const remaining = this.budget - this.usedBytes;
      if (remaining <= MARKER_RESERVE) {
        // Budget exhausted: silently skip the rest. A per-directory
        // "[dropped]" notice would spam the transcript with a system message
        // for every new directory touched after the cap (review fix); the
        // truncation marker on the crossing file already tells the story.
        this.usedBytes = this.budget;
        continue;
      }
      const bytes = Buffer.byteLength(text, 'utf-8');
      if (bytes <= remaining) {
        this.usedBytes += bytes;
        out.push({ file: found, content: text });
      } else {
        const cut = safeUtf8Boundary(Buffer.from(text, 'utf-8'), remaining - MARKER_RESERVE);
        const content = Buffer.from(text, 'utf-8').subarray(0, cut).toString('utf-8');
        const marker = `\n[truncated at ${this.budget}-byte budget]`;
        this.usedBytes += Buffer.byteLength(content + marker, 'utf-8');
        out.push({ file: found, content: `${content}${marker}` });
      }
    }
    return out;
  }

  /** Directories from the file's parent up to (excluding) rootDir, shallow-first. */
  private directoryChain(absoluteFilePath: string): string[] {
    const chain: string[] = [];
    let cur = path.dirname(path.resolve(absoluteFilePath));
    while (cur !== path.dirname(cur) && path.resolve(cur) !== this.rootDir && cur.startsWith(this.rootDir)) {
      chain.unshift(cur);
      cur = path.dirname(cur);
    }
    return chain;
  }

  private findInstructionFile(dir: string): string | null {
    for (const name of this.names) {
      const p = path.join(dir, name);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        // absent
      }
    }
    return null;
  }
}

/** Largest byte index <= cap that does NOT split a UTF-8 sequence. */
function safeUtf8Boundary(buf: Buffer, cap: number): number {
  let i = Math.min(cap, buf.length);
  for (;;) {
    const byte = buf[i];
    if (byte === undefined || (byte & 0xc0) !== 0x80) return i; // sequence start / end
    i--;
  }
}
