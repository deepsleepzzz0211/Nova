import { displayWidth, padToWidth } from './text-measure.js';
import { fmtTokens } from './status-format.js';

/**
 * Centred decorative rule for context-policy notices (tui-redesign 07):
 * the machine-readable `[context …]` system line renders as
 * `──── Context compacted · 168.2k → 41.9k tokens · (pressure) ────`,
 * padded to the terminal width. Non-matching notices return null.
 */
const CONTEXT_NOTICE_RE =
  /^\[context (compacted|micro-compacted|truncated) \((\w+)\): (\d+) → (\d+) tokens\]$/;

export function decoratedContextNotice(content: string, width: number): string | null {
  const m = CONTEXT_NOTICE_RE.exec(content);
  if (m === null) return null;
  const [, strategy, reason, before, after] = m;
  const body = `──── Context ${strategy} · ${fmtTokens(Number(before))} → ${fmtTokens(Number(after))} tokens · (${reason}) ────`;
  const room = Math.max(0, width - displayWidth(body));
  const left = Math.floor(room / 2);
  return padToWidth(' '.repeat(left) + body, width);
}
