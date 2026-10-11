import { errorMessage } from '../shared/errors.js';
import * as fs from 'fs';
import * as path from 'path';
import type { Tool } from '../tools/types.js';

/**
 * Cross-session learned memory (memory-v2 ticket 01; Claude Code / ZCode shape).
 *
 * Storage is ONE FACT PER TOPIC FILE: a Markdown file whose frontmatter
 * carries a kebab-case slug, a one-line description (the recall hook), and a
 * type (user | feedback | project | reference). Each memory tree keeps a
 * `MEMORY.md` INDEX of one-line pointers; the index — never the bodies — is
 * what gets injected into the frozen system prompt at startup (cache
 * philosophy: byte-identical prompt for the whole session, next session sees
 * what this one wrote down). The index is capped (200 lines / 25KB) with an
 * explicit truncation warning, mirroring the proven upstream discipline:
 * update an existing memory instead of creating a duplicate, delete facts
 * proven wrong, never store what the repo already records.
 *
 * `appendMemory` and plain-bullet indexes stay supported for legacy files:
 * pre-topic-format MEMORY.md content loads and renders untouched.
 */

/** Read a memory file; empty string when missing/unreadable. */
export function readMemory(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8').trim();
  } catch {
    return '';
  }
}

/** Append a date-stamped fact bullet; creates parent directories. Legacy format. */
export function appendMemory(filePath: string, fact: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(filePath, `- [${date}] ${fact.trim()}\n`, 'utf-8');
}

/** The four memory categories (ZCode recall typing). */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** Index budget: lines and characters. Over either, the index is cut + warned. */
const INDEX_LINE_LIMIT = 200;
const INDEX_CHAR_LIMIT = 25_000;

const LEADING_FRONTMATTER_RE = /^---\s*\n[\s\S]*?---\s*\n?/;

/**
 * Format a MEMORY.md index for prompt injection: strip any leading
 * frontmatter, trim, and cap at 200 lines / 25KB (cut on a line boundary).
 * When anything was dropped, append a WARNING that names the overshoot and
 * tells the model how to fix it (one-line entries, detail into topic files).
 */
export function formatMemoryIndex(content: string): string {
  const trimmed = content.replace(LEADING_FRONTMATTER_RE, '').trim();
  if (!trimmed) return '';
  const lines = trimmed.split('\n');
  const lineTruncated = lines.length > INDEX_LINE_LIMIT;
  let out = lineTruncated ? lines.slice(0, INDEX_LINE_LIMIT).join('\n') : trimmed;
  const charTruncated = out.length > INDEX_CHAR_LIMIT;
  if (charTruncated) {
    const cut = out.lastIndexOf('\n', INDEX_CHAR_LIMIT);
    out = out.slice(0, cut > 0 ? cut : INDEX_CHAR_LIMIT);
  }
  if (!lineTruncated && !charTruncated) return out;
  const size =
    charTruncated && !lineTruncated
      ? `${lines.join('\n').length} chars (limit: ${INDEX_CHAR_LIMIT}) — index entries are too long`
      : lineTruncated && !charTruncated
        ? `${lines.length} lines (limit: ${INDEX_LINE_LIMIT})`
        : `${lines.length} lines and oversized entries`;
  return `${out}\n\n> WARNING: MEMORY.md is ${size}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`;
}

/** Input accepted by {@link upsertMemoryTopic}. */
export interface MemoryTopic {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

/** Kebab-case a display name into a filename slug; '' when nothing survives. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function renderTopicFile(topic: MemoryTopic & { name: string }): string {
  return [
    '---',
    `name: ${topic.name}`,
    `description: ${topic.description}`,
    'metadata:',
    `  type: ${topic.type}`,
    '---',
    '',
    topic.body,
    '',
  ].join('\n');
}

/**
 * Write (or REPLACE) one topic file in a memory tree and upsert its index
 * line in MEMORY.md: `- [slug](slug.md) — description`. Re-upserting the same
 * name updates the file and rewrites the existing index line IN PLACE, so the
 * index can never grow duplicates. Legacy plain-bullet index content is kept.
 * Throws on empty/unsuitable name, description, or body.
 */
export function upsertMemoryTopic(memoryDir: string, input: MemoryTopic): string {
  const slug = slugify(input.name);
  if (!slug) throw new Error('memory name must contain letters or digits to form a file slug');
  const description = input.description.trim();
  const body = input.body.trim();
  if (!description) throw new Error('memory description is required (the one-line recall hook)');
  if (!body) throw new Error('memory body is required');
  if (!MEMORY_TYPES.includes(input.type)) {
    throw new Error(`unknown memory type "${input.type}" (expected: ${MEMORY_TYPES.join(', ')})`);
  }
  fs.mkdirSync(memoryDir, { recursive: true });
  const fileName = `${slug}.md`;
  fs.writeFileSync(path.join(memoryDir, fileName), renderTopicFile({ ...input, name: slug }), 'utf-8');

  const indexPath = path.join(memoryDir, 'MEMORY.md');
  const link = `](${fileName})`;
  const entry = `- [${slug}](${fileName}) — ${description}`;
  const current = readMemory(indexPath);
  const lines = current ? current.split('\n') : [];
  const at = lines.findIndex((l) => l.startsWith('- ') && l.includes(link));
  if (at >= 0) lines[at] = entry;
  else lines.push(entry);
  fs.writeFileSync(indexPath, `${lines.join('\n')}\n`, 'utf-8');
  return fileName;
}

/**
 * Build the "Memory" prompt section from one or more memory trees: a short
 * preamble naming each directory (bodies live in topic files there; the index
 * links them), then each tree's CAPPED index. Returns '' when every index is
 * empty, so a fresh install pays no tokens.
 */
export function buildMemorySection(memoryDirs: string[]): string {
  const blocks: string[] = [];
  for (const dir of memoryDirs) {
    const index = formatMemoryIndex(readMemory(path.join(dir, 'MEMORY.md')));
    if (!index) continue;
    blocks.push(`Memory topics (one fact per file) live in ${dir}/:\n\n${index}`);
  }
  if (blocks.length === 0) return '';
  return [
    'You have persistent, cross-session memory: bodies live in topic files (frontmatter: name, description, type — one fact per file), indexed by the MEMORY.md excerpts below. The index lines are all the memory you see at startup.',
    'RECALL ON DEMAND: when an index line looks relevant, search the memory directory named below with the grep tool (keyword or description), then read_file the matching topic file before answering; if nothing matches, say so — never invent or paraphrase remembered content.',
    'When saving with memory_write: one fact per file, update an existing topic instead of creating a duplicate, delete memories proven wrong, and skip things the repo, git history, or AGENTS.md already record.',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

/** The two memory trees a session writes to (memory-v2 ticket 02). */
export interface MemoryTrees {
  /** User-level tree under NOVA_HOME — private to this machine. */
  user: string;
  /** Project-level tree under <repo>/.nova — shared with the team via the repo. */
  project: string;
}

/**
 * memory_write tool bound to BOTH memory trees. `scope` routes the write:
 * 'user' → the private tree, 'project' (default) → the repo tree. The
 * description carries the write discipline AND the routing rules so they are
 * present even in sessions that have no memories yet.
 */
export function createMemoryTool(trees: MemoryTrees): Tool {
  return {
    name: 'memory_write',
    description:
      'Persist one durable fact to long-term memory as its own topic file (one fact per file). ' +
      'Available to future sessions via the MEMORY.md index. Choose type: user (who the user is, ' +
      'preferences), feedback (how the user wants you to work — include the why), project ' +
      '(goals/constraints not derivable from code or git), reference (pointers to external ' +
      'resources). Choose scope: "user" for personal preferences and machine-local environment ' +
      'facts (private to this machine); "project" for team-shared conventions, build/deploy ' +
      'commands, and repo goals — the default. Before saving, check the index for an existing ' +
      'topic that covers it and RE-USE its name to update in place; never store what the repo or ' +
      'AGENTS.md already records. Not for transient task state (use todo_write).',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short kebab-case topic slug, e.g. pnpm-only.' },
        description: { type: 'string', description: 'One-line recall hook shown in the index (under ~200 chars).' },
        type: { type: 'string', enum: [...MEMORY_TYPES], description: 'Memory category.' },
        scope: { type: 'string', enum: ['user', 'project'], description: 'Which tree to write: user (private, this machine only) or project (shared via the repo). Default: project.' },
        fact: { type: 'string', description: 'The fact itself; for feedback/project also include **Why:** and **How to apply:** lines.' },
      },
      required: ['name', 'description', 'type', 'fact'],
    },
    metadata: { category: 'memory', cacheable: false, timeout: 5_000 },
    async execute(params) {
      const scope = params.scope === undefined ? 'project' : params.scope;
      if (scope !== 'user' && scope !== 'project') {
        return { content: `memory_write failed: unknown scope "${String(scope)}" (expected user or project)`, isError: true };
      }
      try {
        const fileName = upsertMemoryTopic(trees[scope], {
          name: typeof params.name === 'string' ? params.name : '',
          description: typeof params.description === 'string' ? params.description : '',
          type: (params.type ?? '') as MemoryType,
          body: typeof params.fact === 'string' ? params.fact : '',
        });
        return { content: `Remembered to ${scope}/${fileName} (index updated).` };
      } catch (err) {
        return { content: `memory_write failed: ${errorMessage(err)}`, isError: true };
      }
    },
  };
}
