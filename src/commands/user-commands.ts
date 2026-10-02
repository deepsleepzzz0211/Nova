import * as fs from 'fs';
import * as path from 'path';

/**
 * User-defined slash commands (batch-B ticket 04): markdown files in
 * `~/.nova/commands/` (and the project-level `.nova/commands/`) become
 * prompt templates invocable as `/name args`. Execution routes the EXPANDED
 * template through the normal user-message path — the model sees exactly
 * what the user typed would have produced, so no new trust level exists.
 */

/** One loaded user command. */
export interface UserCommand {
  /** File stem; kebab-case (`^[a-z0-9][a-z0-9-]*$`). */
  name: string;
  description: string;
  argumentHint?: string;
  /** Prompt template; $1..$9 and $ARGUMENTS slots. */
  template: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Parse one command file. Returns null (and lets the caller warn) for
 * invalid names or empty bodies. Front-matter is the narrow subset
 * description / argument_hint; without it the whole file is the template.
 */
export function parseUserCommandFile(
  fileName: string,
  content: string,
  warn: (message: string) => void = () => {},
): UserCommand | null {
  const name = fileName.replace(/\.md$/, '');
  if (!NAME_RE.test(name)) {
    warn(`[commands] skipped ${fileName}: name must be kebab-case (${NAME_RE})`);
    return null;
  }
  const normalized = content.replace(/\r\n/g, '\n');
  let description = '';
  let argumentHint: string | undefined;
  let body = normalized;

  const fm = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    body = normalized.slice(fm[0].length);
    for (const line of fm[1].split('\n')) {
      const kv = line.match(/^\s*([A-Za-z_]+)\s*:\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      const value = kv[2].trim();
      if (key === 'description') description = value;
      else if (key === 'argument_hint') argumentHint = value;
    }
  }

  const template = body.trim();
  if (template === '') {
    warn(`[commands] skipped ${fileName}: empty template`);
    return null;
  }
  return { name, description, ...(argumentHint !== undefined ? { argumentHint } : {}), template };
}

/** Split an argument line into positional words (quoted runs group). */
function splitArgs(argsLine: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(argsLine)) !== null) {
    out.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return out;
}

/**
 * Fill $1..$9 and $ARGUMENTS. Placeholders without a matching argument stay
 * literally (so a missing arg surfaces as the raw template token rather than
 * silently vanishing).
 */
export function expandUserCommand(template: string, argsLine: string): string {
  const trimmed = argsLine.trim();
  const positional = trimmed === '' ? [] : splitArgs(trimmed);
  let out = template.replace(/\$(\d)/g, (whole, digit: string) => {
    const idx = Number(digit) - 1;
    return idx < positional.length ? positional[idx] : whole;
  });
  if (positional.length > 0) out = out.replaceAll('$ARGUMENTS', trimmed);
  return out;
}

/** Load every valid command from one directory (missing dir → []). */
export function loadUserCommands(
  dir: string,
  warn: (message: string) => void = () => {},
): UserCommand[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: UserCommand[] = [];
  for (const file of entries.filter((f) => f.endsWith('.md')).sort()) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(dir, file), 'utf-8');
    } catch {
      warn(`[commands] skipped ${file}: unreadable`);
      continue;
    }
    const cmd = parseUserCommandFile(file, content, warn);
    if (cmd) out.push(cmd);
  }
  return out;
}
