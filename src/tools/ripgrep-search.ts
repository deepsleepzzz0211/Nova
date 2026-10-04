/**
 * Core of the ripgrep-backed search tools (search-tools ticket 01/02;
 * arch2 ticket B1 deepening): the two facades runGrepSearch/runGlobListing
 * own the whole orchestration - argv construction, the engine run with its
 * error mapping, output parsing, rendering, and pagination. grep.ts/glob.ts
 * decode model parameters (via tools/args.ts) and call ONE function; the old
 * shape had each tool re-assemble nine helpers, and the test suite imported
 * eight internals - the test surface WAS the wrong module shape. The engine
 * I/O seam (RipgrepRun) is injected, so everything here stays unit-testable.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { toSlashes } from '../shared/paths.js';
import { errorMessage } from '../shared/errors.js';
import type { ToolResult } from './types.js';

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

/** Execution environment a facade drives one search through. */
export interface SearchEnv {
  run: RipgrepRun;
  workingDirectory: string;
  signal: AbortSignal;
  timeoutMs: number;
  /** User-facing prefix when the runner throws, e.g. "grep failed". */
  failurePrefix: string;
  /** Pagination: visible cap (0 = unlimited; default DEFAULT_HEAD_LIMIT). */
  headLimit?: number;
  /** Pagination: items to skip before limiting. */
  offset?: number;
}

/** grep: run one SearchRequest end to end and render for its mode. */
export async function runGrepSearch(
  req: SearchRequest,
  env: SearchEnv,
  content: { showLineNumbers: boolean } = { showLineNumbers: true },
): Promise<ToolResult> {
  const result = await execute(buildGrepArgs(req), env);
  if ('isError' in result) return result;
  if (req.outputMode === 'files') {
    // Engine traversal order, not mtime: grep files-mode answers "where does X
    // live", and stat-ing the full match set for an ordering nobody asked for
    // is exactly the loop-stall this batch avoids (search-tools review).
    return { content: renderFileList(parseFilesList(result.stdout), env, { sortByMtime: false }) };
  }
  if (req.outputMode === 'count') {
    return { content: renderCount(result.stdout, env) };
  }
  return { content: renderContent(result.stdout, env, content.showLineNumbers, req.onlyMatching === true) };
}

/** glob: filename listing for a pattern, newest-modified first. */
export async function runGlobListing(
  pattern: string,
  searchPath: string,
  env: SearchEnv,
): Promise<ToolResult> {
  const result = await execute(buildGlobArgs(pattern, searchPath), env);
  if ('isError' in result) return result;
  return { content: renderFileList(parseFilesList(result.stdout), env, { sortByMtime: true }) };
}

/** Run + the two shared failure mappings (throw, engine usage error code 2). */
async function execute(
  args: string[],
  env: SearchEnv,
): Promise<RipgrepResult | { content: string; isError: true }> {
  try {
    const result = await env.run(args, { signal: env.signal, timeoutMs: env.timeoutMs });
    if (result.code === 2) {
      return { content: `ripgrep error: ${firstErrorLine(result.stderr)}`, isError: true };
    }
    return result;
  } catch (err) {
    return { content: `${env.failurePrefix}: ${errorMessage(err)}`, isError: true };
  }
}

/** Build the ripgrep argv for one search request. */
function buildGrepArgs(req: SearchRequest): string[] {
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
  if (req.glob) args.push('--glob', normalizeGlobPattern(req.glob));
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
function parseFilesList(stdout: string): string[] {
  if (!stdout) return [];
  return stdout.split('\u0000').filter((p) => p.length > 0);
}

/**
 * Normalize a model-supplied glob pattern for rg `--glob` matching.
 *
 * rg matches slash-containing patterns against the FULL displayed path, and we
 * search with absolute paths — so a root-relative pattern like
 * `src` + doublestar glob must be prefixed with a doublestar segment to match.
 * Backslashes (a Windows model habit) normalize to slashes first; a bare
 * filename glob stays a basename pattern, which rg matches at any depth.
 */
function normalizeGlobPattern(pattern: string): string {
  const slashed = toSlashes(pattern.trim());
  if (!slashed.includes('/')) return slashed;
  if (slashed.startsWith('/') || slashed.startsWith('**/')) return slashed;
  return `**/${slashed}`;
}

/** Build the ripgrep argv for a filename-glob listing (`--files --glob …`). */
function buildGlobArgs(pattern: string, searchPath: string): string[] {
  const args: string[] = ['--no-config', '--files', '--null'];
  if (pattern) args.push('--glob', normalizeGlobPattern(pattern));
  args.push('--', searchPath);
  return args;
}

/** Display path: relative to the working directory when possible, forward slashes. */
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
 * Shared render for file-path result sets (grep files mode, glob). One stat
 * pass per matched path at most — for an mtime-sorted caller the set is file
 * paths (cheap), never file contents.
 */
function renderFileList(
  absPaths: string[],
  env: SearchEnv,
  opts: { sortByMtime: boolean },
): string {
  if (absPaths.length === 0) return 'No files found';
  const ordered = opts.sortByMtime ? sortPathsByMtime(absPaths) : absPaths;
  const page = paginate(
    ordered.map((f) => relativize(f, env.workingDirectory)),
    env.headLimit,
    env.offset,
  );
  const header = `Found ${ordered.length} ${ordered.length === 1 ? 'file' : 'files'}`;
  return `${header}\n${page.items.join('\n')}${formatPaginationNote(page.appliedLimit, page.appliedOffset)}`;
}

/** Parse `-c --null` output (`path\0count` per line). */
function parseCountList(stdout: string): Array<{ path: string; count: number }> {
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
interface ContentEvent {
  path: string;
  lineNumber?: number;
  text: string;
  isMatch: boolean;
  /** -o payload: the matched substrings on this line. */
  matches: string[];
}

/** Parse `--json` (JSON Lines) output into match/context events. */
function parseContentEvents(stdout: string): ContentEvent[] {
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
function paginate<T>(
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
function renderClip(text: string, maxChars = 500): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

/** Render `-c` counts: per-file lines plus a total-occurrences summary. */
function renderCount(stdout: string, env: SearchEnv): string {
  const rows = parseCountList(stdout);
  if (rows.length === 0) return 'No matches found';
  const page = paginate(rows, env.headLimit, env.offset);
  const lines = page.items.map((r) => `${relativize(r.path, env.workingDirectory)}:${r.count}`);
  const totalMatches = rows.reduce((sum, r) => sum + r.count, 0);
  const shown = page.items.length;
  const shownNote = shown === rows.length ? '' : ` (listing ${shown})`;
  const summary = `Found ${totalMatches} total ${totalMatches === 1 ? 'occurrence' : 'occurrences'} across ${rows.length} ${rows.length === 1 ? 'file' : 'files'}${shownNote}.`;
  return `${lines.join('\n')}\n\n${summary}${formatPaginationNote(page.appliedLimit, page.appliedOffset)}`;
}

/** Render `--json` match/context lines with optional line numbers. */
function renderContent(
  stdout: string,
  env: SearchEnv,
  showLineNumbers: boolean,
  onlyMatching: boolean,
): string {
  const events = parseContentEvents(stdout);
  if (events.length === 0) return 'No matches found';
  const rendered = events.map((e) => {
    const file = relativize(e.path, env.workingDirectory);
    const body = onlyMatching && e.matches.length > 0 ? e.matches.join(' ') : renderClip(e.text);
    const sep = e.isMatch ? ':' : '-';
    if (showLineNumbers && e.lineNumber !== undefined) return `${file}${sep}${e.lineNumber}${sep}${body}`;
    return `${file}${sep}${body}`;
  });
  const page = paginate(rendered, env.headLimit, env.offset);
  return `${page.items.join('\n')}${formatPaginationNote(page.appliedLimit, page.appliedOffset)}`;
}


/** First line of an engine stderr as the user-facing error. */
function firstErrorLine(stderr: string): string {
  return stderr.trim().split('\n')[0] ?? 'unknown error';
}

/** Pagination echo suffix (Claude-style), or '' when nothing was applied. */
function formatPaginationNote(appliedLimit?: number, appliedOffset?: number): string {
  const parts: string[] = [];
  if (appliedLimit !== undefined) parts.push(`limit: ${appliedLimit}`);
  if (appliedOffset !== undefined) parts.push(`offset: ${appliedOffset}`);
  return parts.length > 0 ? `\n\n[Showing results with pagination: ${parts.join(', ')}]` : '';
}
