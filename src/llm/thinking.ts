import type { ThinkingLevel, ThinkingLevelMap } from './compat.js';

/** Minimal model info needed to resolve thinking params. */
export interface ThinkingModelInfo {
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
}

/** Result of resolving a thinking level for a model. */
export interface ResolvedThinking {
  /** Whether a thinking parameter should be sent. */
  send: boolean;
  /** Provider value (identity string for openai; see per-API budget maps). */
  value?: string;
}

/**
 * Resolve a unified thinking level against a model's thinkingLevelMap
 * (pi semantics):
 *  - off / undefined → nothing sent
 *  - non-reasoning model → nothing sent
 *  - map entry null → unsupported → clamped away (nothing sent)
 *  - map entry string → send that value
 *  - no map entry → minimal/low/medium/high supported (identity),
 *    xhigh/max unsupported
 */
export function resolveThinking(model: ThinkingModelInfo, level?: ThinkingLevel): ResolvedThinking {
  if (!level || level === 'off' || !model.reasoning) {
    return { send: false };
  }

  const mapped = model.thinkingLevelMap?.[level];
  if (mapped !== undefined) {
    return mapped === null ? { send: false } : { send: true, value: mapped };
  }

  // Default mapping: standard levels supported, extended ones not
  if (level === 'minimal' || level === 'low' || level === 'medium' || level === 'high') {
    return { send: true, value: level };
  }
  return { send: false };
}

/** Anthropic thinking budgets per level (default mapping). */
const ANTHROPIC_BUDGETS: Record<Exclude<ThinkingLevel, 'off'>, number> = {
  minimal: 1024,
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 64000,
};

/**
 * Resolve the Anthropic thinking budget for a level.
 * Custom string values in thinkingLevelMap are Anthropic-specific values pi
 * would send as-is; Nova maps levels to budgets and ignores custom strings
 * (documented limitation). null entries still clamp.
 */
export function resolveAnthropicBudget(model: ThinkingModelInfo, level?: ThinkingLevel): number | null {
  if (!level || level === 'off' || !model.reasoning) {
    return null;
  }
  const mapped = model.thinkingLevelMap?.[level];
  if (mapped === null) {
    return null;
  }
  return ANTHROPIC_BUDGETS[level];
}
