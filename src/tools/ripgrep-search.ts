/**
 * Pure core of the ripgrep-backed search tools (search-tools ticket 01/02):
 * argv construction, output parsing for the three render modes, and
 * pagination. Kept free of I/O so the engine contract stays unit-testable;
 * the WASM execution seam lives in ripgrep-worker.ts.
 */

/** Result of one raw ripgrep invocation. */
export interface RipgrepResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injectable runner seam: argv in, buffered result out (throw on timeout/cancel). */
export type RipgrepRun = (
  args: readonly string[],
  options: { signal: AbortSignal; timeoutMs: number },
) => Promise<RipgrepResult>;

/** Render mode for a content search. */
export type SearchOutputMode = 'content' | 'files' | 'count';

/** Normalized request accepted by {@link buildGrepArgs}. */
export interface SearchRequest {
  pattern: string;
  /** Already-absolute, forward-slash search target. */
  searchPath: string;
  outputMode: SearchOutputMode;
  glob?: string;
  type?: string;
  ignoreCase?: boolean;
  /** Content mode only: restrict output to the matched span. */
  onlyMatching?: boolean;
  multiline?: boolean;
  /** Content mode only. */
  beforeContext?: number;
  /** Content mode only. */
  afterContext?: number;
  /** Content mode only (symmetric -C). */
  context?: number;
}

/** Default visible cap; 0 means unlimited. Mirrors the industry head_limit norm. */
export const DEFAULT_HEAD_LIMIT = 250;

/** Convert Windows separators to the forward slashes the WASM guest requires. */
export function toSlashes(p: string): string {
  return p.split('\\').join('/');
}

/** Build the ripgrep argv for one search request. */
export function buildGrepArgs(req: SearchRequest): string[] {
  const args: string[] = ['--no-config'];
  if (req.outputMode === 'files') {
    args.push('-l', '--null');
  } else if (req.outputMode === 'count') {
    args.push('-c', '--null');
  } else {
    args.push('--json');
  }
  if (req.ignoreCase) args.push('-i');
  if (req.multiline) args.push('-U', '--multiline-dotall');
  if (req.glob) args.push('--glob', req.glob);
  if (req.type) args.push('--type', req.type);
  if (req.outputMode === 'content') {
    if (req.onlyMatching) args.push('-o');
    const context = req.context;
    if (context !== undefined) {
      args.push('-C', String(context));
    } else {
      if (req.beforeContext !== undefined) args.push('-B', String(req.beforeContext));
      if (req.afterContext !== undefined) args.push('-A', String(req.afterContext));
    }
  }
  // -e keeps a dash-leading pattern from being parsed as a flag; -- fences the path.
  args.push('-e', req.pattern, '--', req.searchPath);
  return args;
}

/** Parse `-l --null` output (NUL-separated absolute paths). */
export function parseFilesList(stdout: string): string[] {
  if (!stdout) return [];
  return stdout.split('\u0000').filter((p) => p.length > 0);
}

/** Parse `-c --null` output (`path\0count` per line). */
export function parseCountList(stdout: string): Array<{ path: string; count: number }> {
  if (!stdout) return [];
  const out: Array<{ path: string; count: number }> = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const sep = line.indexOf('\u0000');
    if (sep === -1) continue;
    const count = Number.parseInt(line.slice(sep + 1), 10);
    out.push({ path: line.slice(0, sep), count: Number.isNaN(count) ? 0 : count });
  }
  return out;
}

/** One rendered line from `--json` output. */
export interface ContentEvent {
  path: string;
  lineNumber?: number;
  text: string;
  isMatch: boolean;
  /** -o payload: the matched substrings on this line. */
  matches: string[];
}

/** Parse `--json` (JSON Lines) output into match/context events. */
export function parseContentEvents(stdout: string): ContentEvent[] {
  const events: ContentEvent[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let record: { type?: string; data?: Record<string, unknown> };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue; // non-JSON noise from the engine never breaks a search
    }
    if (record.type !== 'match' && record.type !== 'context') continue;
    const data = record.data ?? {};
    const path = (data.path as { text?: string } | undefined)?.text;
    if (!path) continue;
    const text = ((data.lines as { text?: string } | undefined)?.text ?? '').replace(/[\r\n]+$/, '');
    const lineNumber = data.line_number as number | undefined;
    const matches = (data.submatches as Array<{ match: { text?: string } }> | undefined)?.map(
      (s) => s.match.text ?? '',
    );
    events.push({ path, lineNumber, text, isMatch: record.type === 'match', matches: matches ?? [] });
  }
  return events;
}

/** Page a rendered item list: offset first, then head limit (0 = unlimited). */
export function paginate<T>(
  items: T[],
  headLimit?: number,
  offset?: number,
): { items: T[]; appliedLimit?: number; appliedOffset?: number } {
  const limit = headLimit === undefined ? DEFAULT_HEAD_LIMIT : headLimit;
  const skip = offset && offset > 0 ? offset : undefined;
  const afterSkip = skip === undefined ? items : items.slice(skip);
  if (limit === 0) {
    return { items: afterSkip, appliedOffset: skip };
  }
  if (afterSkip.length > limit) {
    return { items: afterSkip.slice(0, limit), appliedLimit: limit, appliedOffset: skip };
  }
  return { items: afterSkip, appliedOffset: skip };
}

/** Clip one output line so a minified file cannot flood the context. */
export function renderClip(text: string, maxChars = 500): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

/** Pagination echo suffix (Claude-style), or '' when nothing was applied. */
export function formatPaginationNote(appliedLimit?: number, appliedOffset?: number): string {
  const parts: string[] = [];
  if (appliedLimit !== undefined) parts.push(`limit: ${appliedLimit}`);
  if (appliedOffset !== undefined) parts.push(`offset: ${appliedOffset}`);
  return parts.length > 0 ? `\n\n[Showing results with pagination: ${parts.join(', ')}]` : '';
}
