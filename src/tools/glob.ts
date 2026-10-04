import type { Tool, ToolContext, ToolResult } from './types.js';
import type { JSONSchema } from '../llm/types.js';
import { numParam, resolveSearchPath } from './args.js';
import { runGlobListing, type RipgrepRun, type SearchEnv } from './ripgrep-search.js';
import { runRipgrep } from './ripgrep-worker.js';

const GLOB_TIMEOUT_MS = 30_000;

const GLOB_PARAMETERS: JSONSchema = {
  type: 'object',
  properties: {
    pattern: {
      type: 'string',
      description:
        'Glob pattern of file names to find, relative to the search directory (e.g. "**/*.tsx", "src/**/*.test.ts"). Forward slashes on every platform.',
    },
    path: {
      type: 'string',
      description:
        'The directory to search in. If not specified, the current working directory is used. IMPORTANT: omit this field for the default — do not enter "undefined" or "null" as a value.',
    },
    head_limit: {
      type: 'number',
      description: 'Limit output to the first N files (default 250; 0 = unlimited).',
    },
    offset: {
      type: 'number',
      description: 'Skip the first N files before head_limit (pagination).',
    },
  },
  required: ['pattern'],
};

/**
 * File-name search over the same embedded ripgrep engine as grep
 * (search-tools ticket 02; arch2 ticket B1 slimmed to a decoder): decode the
 * pattern + pagination and hand off to runGlobListing, which owns argv, the
 * engine run, error mapping, and the newest-modified-first render.
 */
export function createGlobTool(deps: { run?: RipgrepRun; timeoutMs?: number } = {}): Tool {
  const run: RipgrepRun = deps.run ?? runRipgrep;
  const timeoutMs = deps.timeoutMs ?? GLOB_TIMEOUT_MS;
  return {
    name: 'glob',
    display: { kind: 'pattern' },
    permission: { mode: 'auto' },
    metadata: { category: 'search', cacheable: false, timeout: timeoutMs },
    description:
      'A fast file finder by name pattern. Prefer this over `find`/`ls` via bash. Matches files ' +
      'recursively, honors .gitignore, and returns paths newest-modified first so recent work surfaces on top.',
    parameters: GLOB_PARAMETERS,
    async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const pattern = typeof params.pattern === 'string' ? params.pattern : '';
      if (!pattern) return { content: 'glob requires a non-empty pattern.', isError: true };

      const env: SearchEnv = {
        run,
        workingDirectory: context.workingDirectory,
        signal: context.abortSignal,
        timeoutMs,
        failurePrefix: 'glob failed',
        headLimit: numParam(params, 'head_limit'),
        offset: numParam(params, 'offset'),
      };
      return runGlobListing(pattern, resolveSearchPath(params.path, context.workingDirectory), env);
    },
  };
}
