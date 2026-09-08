/**
 * Subagent output scanning (ticket 06, Claude-Code-style prompt-injection
 * defense).
 *
 * A subagent may have read files, web pages, or command output nobody
 * reviewed — that text can carry instructions aimed at the parent
 * conversation. Before the subagent's final report enters the parent
 * context it is scanned:
 *
 *  1. Harness imitation broken: text imitating the harness's own output
 *     structure (`<system-reminder>` tags, `Human:`/`Assistant:` line
 *     starts) gets a backslash inserted so it reads as ordinary text.
 *  2. Marker line: reports that imitate harness tags or mention permission
 *     bypass get a `[harness: ...]` marker prepended.
 *
 * The scan never removes or rewords content — it only marks.
 */

/** Harness structures whose imitation gets broken with a backslash. */
const HARNESS_PATTERNS: readonly { name: string; pattern: RegExp; fix: (m: string) => string }[] = [
  {
    name: 'system-reminder-tag',
    // Match the opening tag (allowing attributes) but not plain angle brackets
    pattern: /<system-reminder[^>]*>/g,
    fix: (m) => `${m}\\`,
  },
  {
    name: 'role-line',
    pattern: /^(?:Human|Assistant):/gm,
    fix: (m) => `\\${m}`,
  },
];

/** Permission-bypass mentions that warrant a marker (text left untouched). */
const PERMISSION_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'bypassPermissions', pattern: /bypassPermissions|bypass permissions/i },
  { name: 'dangerously-skip-permissions', pattern: /--dangerously-skip-permissions/i },
  { name: 'skip-permissions', pattern: /skip(ping)? (the )?permission (checks?|prompts?|system)/i },
];

/**
 * Scan a subagent's final report before it enters the parent context.
 * Returns the (possibly marked) text — content is never deleted.
 */
export function scanSubagentOutput(text: string): string {
  if (!text) return text;

  let broken = text;
  const matched: string[] = [];

  for (const { name, pattern, fix } of HARNESS_PATTERNS) {
    if (pattern.test(broken)) {
      matched.push(name);
      broken = broken.replace(pattern, fix);
    }
  }

  for (const { name, pattern } of PERMISSION_PATTERNS) {
    if (pattern.test(broken)) {
      matched.push(name);
    }
  }

  if (matched.length === 0) return text;
  return `[harness: subagent output matched instruction-shaped pattern(s): ${matched.join(', ')}]\n${broken}`;
}
