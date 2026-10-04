import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * arch2 ticket C: the shared skeleton behind the "load definitions from a
 * directory" pipelines (user slash commands, named agents; a fourth type
 * wants one new parser, zero new plumbing). Missing dir is an empty result,
 * not an error; extension filter and sort are deterministic; an unreadable
 * entry warns with the caller's tag and is skipped; parse returns null to
 * skip bad definitions. Warning WORDING is owned by callers through warnTag
 * (byte-identical messages preserved).
 */
export function loadDefinitionsFromDirs<T>(opts: {
  dir: string;
  extension: string;
  /** Prefix for the unreadable-entry warning, e.g. "[agents]". */
  warnTag: string;
  warn: (message: string) => void;
  parse: (file: string, content: string) => T | null;
}): T[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(opts.dir);
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const file of entries.filter((f) => f.endsWith(opts.extension)).sort()) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(opts.dir, file), 'utf-8');
    } catch {
      opts.warn(`${opts.warnTag} skipped ${file}: unreadable`);
      continue;
    }
    const item = opts.parse(file, content);
    if (item !== null) out.push(item);
  }
  return out;
}
