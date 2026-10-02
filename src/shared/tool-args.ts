import * as path from 'path';

/**
 * Shared extraction of the `path` argument from a tool call's raw JSON
 * arguments (identical shape needed by the directory-instruction hook, the
 * file-checkpoint hook, and the undo window scanner).
 */
export function extractPathArg(argumentsJson: string): string | null {
  try {
    const args = JSON.parse(argumentsJson) as { path?: unknown };
    return typeof args.path === 'string' ? args.path : null;
  } catch {
    return null;
  }
}

/** Resolve a tool `path` argument against the live cwd (the tools' own basis). */
export function resolveToolPath(argumentsJson: string, cwd = process.cwd()): string | null {
  const raw = extractPathArg(argumentsJson);
  return raw === null ? null : path.resolve(cwd, raw);
}
