import * as fs from 'fs';
import * as path from 'path';
import type { Tool } from '../tools/types.js';

/**
 * Cross-session learned memory (Claude Code / Gemini CLI style).
 *
 * Facts the agent learns are appended to a plain Markdown memory file
 * (date-stamped bullets). At startup the user-level and project-level
 * memory files are read ONCE and injected into the frozen system prompt —
 * the prompt stays byte-identical for the whole session (cache philosophy),
 * and the next session picks up what previous sessions wrote down.
 */

/** Read a memory file; empty string when missing/unreadable. */
export function readMemory(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8').trim();
  } catch {
    return '';
  }
}

/** Join multiple memory files into one section body (dedupes blanks). */
export function readMemorySections(filePaths: string[]): string {
  const parts = filePaths
    .map((p) => readMemory(p))
    .filter((s) => s.length > 0);
  return parts.join('\n\n');
}

/** Append a date-stamped fact bullet; creates parent directories. */
export function appendMemory(filePath: string, fact: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(filePath, `- [${date}] ${fact.trim()}\n`, 'utf-8');
}

/**
 * memory_write tool: lets the agent persist a durable fact for future
 * sessions. Writes to the project-level memory file.
 */
export function createMemoryTool(filePath: string): Tool {
  return {
    name: 'memory_write',
    description:
      'Persist a durable fact, preference, or decision to long-term memory. ' +
      'It will be available in future sessions. Use for stable facts worth ' +
      'remembering (conventions, environments, user preferences) — not for ' +
      'transient task state (use todo_write instead).',
    parameters: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'The fact to remember, one self-contained sentence.' },
      },
      required: ['fact'],
    },
    metadata: { category: 'memory', cacheable: false, timeout: 5000 },
    async execute(params) {
      const fact = typeof params.fact === 'string' ? params.fact.trim() : '';
      if (!fact) {
        return { content: 'memory_write requires a non-empty fact.', isError: true };
      }
      try {
        appendMemory(filePath, fact);
        return { content: `Remembered: ${fact}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: `Failed to write memory: ${msg}`, isError: true };
      }
    },
  };
}
