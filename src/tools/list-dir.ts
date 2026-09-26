import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolContext, ToolResult } from './types.js';
import type { JSONSchema } from '../llm/types.js';

const DEFAULT_HEAD_LIMIT = 500;

const LIST_DIR_PARAMETERS: JSONSchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description:
        'Directory to list (single level). Omit for the current working directory. Forward slashes on every platform.',
    },
    head_limit: {
      type: 'number',
      description: `Limit entries shown (default ${DEFAULT_HEAD_LIMIT}; 0 = unlimited).`,
    },
    offset: {
      type: 'number',
      description: 'Skip the first N entries before head_limit (pagination).',
    },
  },
  required: [],
};

/** Compact human size: 2048 -> "2.0K", 512 -> "512B". */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const units = ['K', 'M', 'G', 'T'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)}${units[i]}`;
}

function oneLevel(dir: string): string[] {
  const dirents = fs.readdirSync(dir, { withFileTypes: true });
  const dirs: string[] = [];
  const others: string[] = [];
  for (const entry of dirents) {
    const name = entry.name;
    const suffix = name.startsWith('.') ? ' (hidden)' : '';
    if (entry.isDirectory()) {
      dirs.push(`${name}/${suffix}`);
    } else if (entry.isSymbolicLink()) {
      others.push(`${name} (link)${suffix}`);
    } else {
      let size = '';
      try {
        size = ` ${humanSize(fs.lstatSync(path.join(dir, name)).size)}`;
      } catch {
        size = ' ?';
      }
      others.push(`${name}${size}${suffix}`);
    }
  }
  dirs.sort(compareNames);
  others.sort(compareNames);
  return [...dirs, ...others];
}

/** Case-insensitive alphabetical, tie-broken by exact name for stable order. */
function compareNames(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Single-level directory listing (search-tools ticket 03). Native fs — this
 * capability has no ripgrep analogue — giving the model a cheap "look at the
 * shape first" primitive instead of shelling out to `ls`. Directories sort
 * before files; hidden entries and symlinks are annotated, not resolved.
 */
export function createListDirTool(): Tool {
  return {
    name: 'list_dir',
    display: { kind: 'path' },
    permission: { mode: 'auto' },
    metadata: { category: 'search', cacheable: false, timeout: 15_000 },
    description:
      'List the immediate contents of a directory (one level deep): directories first, then ' +
      'files with sizes, hidden entries and symlinks annotated. Prefer this over `ls` via bash, ' +
      'which fails on Windows. Use grep/glob to search deeper.',
    parameters: LIST_DIR_PARAMETERS,
    async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const raw = typeof params.path === 'string' && params.path.length > 0 ? params.path : '.';
      const dir = path.resolve(context.workingDirectory, raw);

      let stat: fs.Stats;
      try {
        stat = fs.statSync(dir);
      } catch {
        return { content: `Directory not found: ${dir}`, isError: true };
      }
      if (!stat.isDirectory()) {
        return { content: `Path is not a directory: ${dir}`, isError: true };
      }

      let entries: string[];
      try {
        entries = oneLevel(dir);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const reason = code === 'EACCES' || code === 'EPERM' ? 'permission denied' : String((err as Error).message);
        return { content: `Cannot read directory (${reason}): ${dir}`, isError: true };
      }
      if (entries.length === 0) return { content: `${dir} is empty` };

      const limit = typeof params.head_limit === 'number' && Number.isFinite(params.head_limit)
        ? params.head_limit
        : DEFAULT_HEAD_LIMIT;
      const offset = typeof params.offset === 'number' && params.offset > 0 ? Math.floor(params.offset) : 0;
      const skipped = offset > 0 ? entries.slice(offset) : entries;
      if (limit === 0) {
        return { content: skipped.join('\n') };
      }
      if (skipped.length > limit) {
        const shown = skipped.slice(0, limit);
        return {
          content: `${shown.join('\n')}\n\n[PARTIAL: showing ${limit} of ${skipped.length} entries (offset ${offset}). Raise head_limit or narrow the path.]`,
        };
      }
      return { content: skipped.join('\n') };
    },
  };
}
