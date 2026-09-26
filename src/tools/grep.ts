import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolContext, ToolResult } from './types.js';
import type { JSONSchema } from '../llm/types.js';
import {
  buildGrepArgs,
  formatPaginationNote,
  paginate,
  parseContentEvents,
  parseCountList,
  parseFilesList,
  renderClip,
  toSlashes,
  type RipgrepRun,
  type SearchOutputMode,
} from './ripgrep-search.js';
import { runRipgrep } from './ripgrep-worker.js';

const GREP_TIMEOUT_MS = 30_000;

const GREP_PARAMETERS: JSONSchema = {
  type: 'object',
  properties: {
    pattern: {
      type: 'string',
      description:
        'Regex pattern (ripgrep syntax, not grep — escape literal braces as \\{ \\}) to search for in file contents',
    },
    path: {
      type: 'string',
      description:
        'File or directory to search in; defaults to the current working directory. Forward slashes on every platform.',
    },
    glob: {
      type: 'string',
      description: 'Glob pattern to filter files (e.g. "*.js", "**/*.tsx")',
    },
    type: {
      type: 'string',
      description: 'File type filter (rg --type): js, ts, py, rust, go, java, ... Often cleaner than glob.',
    },
    output_mode: {
      type: 'string',
      enum: ['content', 'files_with_matches', 'count'],
      description:
        '"content" shows matching lines (supports -A/-B/-C, -n, -o), "files_with_matches" shows file paths (default), "count" shows per-file totals.',
    },
    '-B': { type: 'number', description: 'Lines to show before each match (content mode only)' },
    '-A': { type: 'number', description: 'Lines to show after each match (content mode only)' },
    '-C': { type: 'number', description: 'Alias for context.' },
    context: { type: 'number', description: 'Lines to show on both sides of each match (content mode only)' },
    '-n': { type: 'boolean', description: 'Show line numbers in content output (default true)' },
    '-i': { type: 'boolean', description: 'Case-insensitive search' },
    '-o': {
      type: 'boolean',
      description: 'Print only the matched parts of each line (content mode only)',
    },
    multiline: {
      type: 'boolean',
      description: 'Let . match newlines and patterns span lines (content searches across line breaks)',
    },
    head_limit: {
      type: 'number',
      description: `Limit output to the first N lines/entries (default ${250}; 0 = unlimited). Large result sets waste context — prefer narrowing the pattern.`,
    },
    offset: {
      type: 'number',
      description: 'Skip the first N lines/entries before head_limit (pagination).',
    },
  },
  required: ['pattern'],
};

function resolveSearchPath(raw: unknown, workingDirectory: string): string {
  const target = typeof raw === 'string' && raw.length > 0 ? raw : '.';
  return toSlashes(path.resolve(workingDirectory, target));
}

function modeOf(raw: unknown): SearchOutputMode {
  if (raw === 'content' || raw === 'count') return raw;
  return 'files';
}

function numParam(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function boolParam(params: Record<string, unknown>, key: string): boolean {
  return params[key] === true;
}

function numOr(v: number | undefined, fallback: number | undefined): number | undefined {
  return v !== undefined ? v : fallback;
}

function firstErrorLine(stderr: string): string {
  const line = stderr.trim().split('\n')[0] ?? 'unknown error';
  return line;
}

function relativize(filePath: string, workingDirectory: string): string {
  const rel = path.relative(workingDirectory, filePath);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return toSlashes(rel);
  return toSlashes(filePath);
}

/** Newest-modified first: models overwhelmingly care about recent files. */
function sortPathsByMtime(absPaths: string[]): string[] {
  const mtimeOf = (p: string): number => {
    try {
      return fs.statSync(p).mtimeMs;
    } catch {
      return 0; // raced deletion (or an injected runner in tests): keep position
    }
  };
  return [...absPaths].sort((a, b) => mtimeOf(b) - mtimeOf(a));
}

/**
 * Content-search tool over the embedded ripgrep engine (search-tools ticket
 * 01). `run` is injectable for unit tests; production uses the worker runner.
 */
export function createGrepTool(deps: { run?: RipgrepRun; timeoutMs?: number } = {}): Tool {
  const run: RipgrepRun = deps.run ?? runRipgrep;
  const timeoutMs = deps.timeoutMs ?? GREP_TIMEOUT_MS;
  return {
    name: 'grep',
    display: { kind: 'pattern' },
    permission: { mode: 'auto' },
    metadata: { category: 'search', cacheable: false, timeout: timeoutMs },
    description:
      'A fast and precise ripgrep content search. Prefer this over `grep`/`rg` via bash — ' +
      'results come back as file:line references you can read precisely, and the search runs ' +
      'outside the main loop with its own timeout. Honors .gitignore, skips hidden/binary files.',
    parameters: GREP_PARAMETERS,
    async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const pattern = typeof params.pattern === 'string' ? params.pattern : '';
      if (!pattern) return { content: 'grep requires a non-empty pattern.', isError: true };

      const searchPath = resolveSearchPath(params.path, context.workingDirectory);
      const mode = modeOf(params.output_mode);
      const showLineNumbers = params['-n'] !== false;
      const contextLines = numParam(params, 'context') ?? numParam(params, '-C');
      const args = buildGrepArgs({
        pattern,
        searchPath,
        outputMode: mode,
        glob: typeof params.glob === 'string' ? params.glob : undefined,
        type: typeof params.type === 'string' ? params.type : undefined,
        ignoreCase: boolParam(params, '-i'),
        onlyMatching: boolParam(params, '-o'),
        multiline: boolParam(params, 'multiline'),
        beforeContext: numOr(numParam(params, '-B'), contextLines),
        afterContext: numOr(numParam(params, '-A'), contextLines),
        context: mode === 'content' ? contextLines : undefined,
      });

      let result;
      try {
        result = await run(args, { signal: context.abortSignal, timeoutMs });
      } catch (err) {
        return { content: `grep failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
      if (result.code === 2) {
        return { content: `ripgrep error: ${firstErrorLine(result.stderr)}`, isError: true };
      }

      if (mode === 'files') {
        return renderFiles(result.stdout, context.workingDirectory, params);
      }
      if (mode === 'count') {
        return renderCount(result.stdout, context.workingDirectory, params);
      }
      return renderContent(result.stdout, context.workingDirectory, params, showLineNumbers, boolParam(params, '-o'));
    },
  };
}

function renderFiles(stdout: string, workingDirectory: string, params: Record<string, unknown>): ToolResult {
  const abs = parseFilesList(stdout);
  if (abs.length === 0) return { content: 'No files found' };
  const sorted = sortPathsByMtime(abs);
  const page = paginate(sorted.map((p) => relativize(p, workingDirectory)), numParam(params, 'head_limit'), numParam(params, 'offset'));
  const header = `Found ${sorted.length} ${sorted.length === 1 ? 'file' : 'files'}`;
  return { content: `${header}\n${page.items.join('\n')}${formatPaginationNote(page.appliedLimit, page.appliedOffset)}` };
}

function renderCount(stdout: string, workingDirectory: string, params: Record<string, unknown>): ToolResult {
  const rows = parseCountList(stdout);
  if (rows.length === 0) return { content: 'No matches found' };
  const page = paginate(rows, numParam(params, 'head_limit'), numParam(params, 'offset'));
  const lines = page.items.map((r) => `${relativize(r.path, workingDirectory)}:${r.count}`);
  const totalMatches = rows.reduce((sum, r) => sum + r.count, 0);
  const summary = `Found ${totalMatches} total ${totalMatches === 1 ? 'occurrence' : 'occurrences'} across ${rows.length} ${rows.length === 1 ? 'file' : 'files'}.`;
  return { content: `${lines.join('\n')}\n\n${summary}${formatPaginationNote(page.appliedLimit, page.appliedOffset)}` };
}

function renderContent(
  stdout: string,
  workingDirectory: string,
  params: Record<string, unknown>,
  showLineNumbers: boolean,
  onlyMatching: boolean,
): ToolResult {
  const events = parseContentEvents(stdout);
  if (events.length === 0) return { content: 'No matches found' };
  const rendered = events.map((e) => {
    const file = relativize(e.path, workingDirectory);
    const body = onlyMatching && e.matches.length > 0 ? e.matches.join(' ') : renderClip(e.text);
    const sep = e.isMatch ? ':' : '-';
    if (showLineNumbers && e.lineNumber !== undefined) return `${file}${sep}${e.lineNumber}${sep}${body}`;
    return `${file}${sep}${body}`;
  });
  const page = paginate(rendered, numParam(params, 'head_limit'), numParam(params, 'offset'));
  return { content: `${page.items.join('\n')}${formatPaginationNote(page.appliedLimit, page.appliedOffset)}` };
}
