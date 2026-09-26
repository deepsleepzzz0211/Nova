import type { Tool, ToolContext, ToolResult } from './types.js';
import type { JSONSchema } from '../llm/types.js';
import {
  buildGlobArgs,
  firstErrorLine,
  formatPaginationNote,
  numParam,
  paginate,
  parseFilesList,
  relativize,
  resolveSearchPath,
  sortPathsByMtime,
  type RipgrepRun,
} from './ripgrep-search.js';
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
 * (search-tools ticket 02): `--files --glob` gives .gitignore-correct file
 * discovery in one shot, sorted newest-modified first.
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

      const searchPath = resolveSearchPath(params.path, context.workingDirectory);
      let result;
      try {
        result = await run(buildGlobArgs(pattern, searchPath), { signal: context.abortSignal, timeoutMs });
      } catch (err) {
        return { content: `glob failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
      if (result.code === 2) {
        return { content: `ripgrep error: ${firstErrorLine(result.stderr)}`, isError: true };
      }

      const abs = parseFilesList(result.stdout);
      if (abs.length === 0) return { content: 'No files found' };
      const sorted = sortPathsByMtime(abs);
      const page = paginate(
        sorted.map((p) => relativize(p, context.workingDirectory)),
        numParam(params, 'head_limit'),
        numParam(params, 'offset'),
      );
      const header = `Found ${sorted.length} ${sorted.length === 1 ? 'file' : 'files'}`;
      return { content: `${header}\n${page.items.join('\n')}${formatPaginationNote(page.appliedLimit, page.appliedOffset)}` };
    },
  };
}
