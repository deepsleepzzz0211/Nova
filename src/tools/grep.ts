import type { Tool, ToolContext, ToolResult } from './types.js';
import type { JSONSchema } from '../llm/types.js';
import { boolParam, numOr, numParam, resolveSearchPath } from './args.js';
import {
  DEFAULT_HEAD_LIMIT,
  runGrepSearch,
  type RipgrepRun,
  type SearchEnv,
  type SearchOutputMode,
  type SearchRequest,
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
      description: `Limit output to the first N lines/entries (default ${DEFAULT_HEAD_LIMIT}; 0 = unlimited). Large result sets waste context — prefer narrowing the pattern.`,
    },
    offset: {
      type: 'number',
      description: 'Skip the first N lines/entries before head_limit (pagination).',
    },
  },
  required: ['pattern'],
};

function modeOf(raw: unknown): SearchOutputMode {
  if (raw === 'content' || raw === 'count') return raw;
  return 'files';
}

/**
 * Content-search tool over the embedded ripgrep engine (search-tools ticket
 * 01; arch2 ticket B1 slimmed to a decoder). This file decodes the model's
 * JSON args into a normalized SearchRequest + SearchEnv and hands off to
 * runGrepSearch, which owns argv, the engine run, error mapping, parsing,
 * rendering, and pagination. `run` is injectable for unit tests.
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
      'A fast and precise ripgrep content search. Prefer this over `grep`/`rg` via bash - ' +
      'results come back as file:line references you can read precisely, and the search runs ' +
      'outside the main loop with its own timeout. Honors .gitignore, skips hidden/binary files.',
    parameters: GREP_PARAMETERS,
    async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const pattern = typeof params.pattern === 'string' ? params.pattern : '';
      if (!pattern) return { content: 'grep requires a non-empty pattern.', isError: true };

      const mode = modeOf(params.output_mode);
      const contextLines = numParam(params, 'context') ?? numParam(params, '-C');
      const req: SearchRequest = {
        pattern,
        searchPath: resolveSearchPath(params.path, context.workingDirectory),
        outputMode: mode,
        glob: typeof params.glob === 'string' ? params.glob : undefined,
        type: typeof params.type === 'string' ? params.type : undefined,
        ignoreCase: boolParam(params, '-i'),
        onlyMatching: boolParam(params, '-o'),
        multiline: boolParam(params, 'multiline'),
        beforeContext: numOr(numParam(params, '-B'), contextLines),
        afterContext: numOr(numParam(params, '-A'), contextLines),
        context: mode === 'content' ? contextLines : undefined,
      };
      const env: SearchEnv = {
        run,
        workingDirectory: context.workingDirectory,
        signal: context.abortSignal,
        timeoutMs,
        failurePrefix: 'grep failed',
        headLimit: numParam(params, 'head_limit'),
        offset: numParam(params, 'offset'),
      };
      return runGrepSearch(req, env, { showLineNumbers: params['-n'] !== false });
    },
  };
}
