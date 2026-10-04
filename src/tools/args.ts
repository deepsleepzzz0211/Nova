import * as path from 'node:path';
import { toSlashes } from '../shared/paths.js';

/**
 * Tool parameter decoding (arch2 ticket C/B1): the small vocabulary every
 * JSON-args tool repeats - finite number params, boolean params, fallback
 * chains, and resolving a model-supplied path against the working directory.
 */

/** Number parameter with a finite-value guard (model sends junk sometimes). */
export function numParam(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Strict-true boolean parameter. */
export function boolParam(params: Record<string, unknown>, key: string): boolean {
  return params[key] === true;
}

/** First defined value wins (param fallback chains like context/-C). */
export function numOr(
  primary: number | undefined,
  fallback: number | undefined,
): number | undefined {
  return primary !== undefined ? primary : fallback;
}

/** Resolve a model-provided search path against the working directory (abs, slashes). */
export function resolveSearchPath(raw: unknown, workingDirectory: string): string {
  const target = typeof raw === 'string' && raw.length > 0 ? raw : '.';
  return toSlashes(path.resolve(workingDirectory, target));
}
