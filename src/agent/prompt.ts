import type { Tool } from '../tools/types.js';
import type { PromptEnvironment } from './environment.js';

/** Metadata for an available skill (one-line listing only). */
export interface SkillMeta {
  name: string;
  description: string;
  path: string;
}

/** Options for building the system prompt. */
export interface BuildPromptOptions {
  /** Runtime environment facts (cwd, platform, git). */
  environment?: PromptEnvironment;
  /** Project-level instructions (AGENTS.md / CLAUDE.md content). */
  projectInstructions?: string;
  /** Cross-session learned memory (user + project MEMORY.md content). */
  memory?: string;
  /** Extra prompt section from config (agent.systemPrompt). */
  customPrompt?: string;
  /**
   * Token ceiling for the "Available Skills" listing. When set, descriptions
   * are truncated in order to fit; skills are never dropped by the budget
   * (only by name sanitization). Undefined = no ceiling.
   */
  skillsBudgetTokens?: number;
  /** Token estimator used for the skills budget. Default ~4 chars/token. */
  countText?: (text: string) => number;
}

/**
 * Whitelist for a capability name rendered into the prompt. Names come from
 * on-disk SKILL.md frontmatter (possibly a third-party install), so anything
 * outside a conservative identifier set — control/escape sequences, path
 * separators, markdown emphasis — is rejected outright (fail-closed).
 */
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/;

/** Control characters (incl. ESC) that must never reach the prompt. */
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/g;

/** Default ceiling for the Available-Skills listing when none is configured. */
const DEFAULT_SKILLS_BUDGET_TOKENS = 2000;

/** Returns the name if it passes the whitelist verbatim, else null (dropped).
 * No inner-char stripping: a control char anywhere fails the regex outright. */
function sanitizeSkillName(name: string): string | null {
  const trimmed = name.trim();
  return SKILL_NAME_RE.test(trimmed) ? trimmed : null;
}

/** Strip control chars from a free-text field before embedding it. */
function scrubControl(text: string): string {
  return text.replace(CONTROL_CHARS_RE, ' ');
}

/** Longest prefix of `text` whose token count is <= `tokens` (token-budget fit). */
function truncateToTokens(
  text: string,
  tokens: number,
  count: (text: string) => number,
): string {
  if (tokens <= 0) return '';
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (count(text.slice(0, mid)) <= tokens) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd();
}

/** A usable budget: fall back to the default for a missing/invalid (NaN,
 * negative, non-number) config value — never fail open to unbounded. */
function normalizeBudget(budget: number | undefined): number {
  return typeof budget === 'number' && Number.isFinite(budget) && budget >= 0
    ? budget
    : DEFAULT_SKILLS_BUDGET_TOKENS;
}

/** Render the skill listing under a token budget (in-order truncation). */
function renderSkillListing(
  skills: SkillMeta[],
  budgetTokens: number | undefined,
  count: (text: string) => number,
): string[] {
  let remaining = normalizeBudget(budgetTokens);
  const lines: string[] = [];
  for (const skill of skills) {
    const name = sanitizeSkillName(skill.name);
    if (name === null) continue; // fail-closed: untrusted name drops the entry
    const description = scrubControl(skill.description);
    const label = `- **${name}**: `;
    const nameOnly = `- **${name}**`;
    const labelCost = count(label);
    const nameOnlyCost = count(nameOnly);
    // Never drop a passed skill: if the budget cannot cover even the name,
    // emit the name-only line (the section is bounded for descriptions).
    if (remaining < labelCost) {
      lines.push(nameOnly);
      remaining = Math.max(0, remaining - nameOnlyCost);
      continue;
    }
    const descBudget = remaining - labelCost;
    if (count(description) <= descBudget) {
      lines.push(label + description);
      remaining = descBudget - count(description);
      continue;
    }
    // Reserve one token for the ellipsis when truncating the description.
    const fitted = truncateToTokens(description, Math.max(0, descBudget - 1), count);
    if (fitted) {
      lines.push(`${label}${fitted}…`);
      remaining = 0;
    } else {
      lines.push(nameOnly);
      remaining = Math.max(0, remaining - nameOnlyCost);
    }
  }
  return lines;
}

/**
 * Build the system prompt:
 * identity → environment → project instructions → tools → skills → custom.
 */
export function buildSystemPrompt(
  tools: Tool[],
  skills: SkillMeta[],
  options?: BuildPromptOptions,
): string {
  const parts: string[] = [];

  // Identity
  parts.push(
    'You are Nova, an expert coding agent that helps with software engineering tasks.',
    'You can read and edit files, run shell commands, search the web, and call MCP tools.',
    'Work methodically: understand the request, inspect relevant files, make careful changes, and verify results.',
    'Use the todo_write tool to track multi-step work and keep the user informed.',
  );

  // Environment
  if (options?.environment) {
    const env = options.environment;
    parts.push('', '## Environment');
    parts.push(`Working directory: ${env.workingDirectory}`);
    parts.push(`Platform: ${env.platform}`);
    if (env.gitBranch) {
      parts.push(`Git branch: ${env.gitBranch}`);
    }
    if (env.gitStatus) {
      parts.push(`Git status:\n${env.gitStatus}`);
    }
  }

  // Project instructions
  if (options?.projectInstructions) {
    parts.push('', '## Project Instructions', options.projectInstructions);
  }

  // Learned memory (loaded once at startup; frozen for the session)
  if (options?.memory) {
    parts.push('', '## Memory', options.memory);
  }

  // Tool descriptions
  if (tools.length > 0) {
    parts.push('', '## Available Tools');
    for (const tool of tools) {
      parts.push(`- **${tool.name}**: ${tool.description}`);
    }
  }

  // Skills (one-line listings; full bodies are injected on demand). Names are
  // sanitized fail-closed and descriptions truncated to the token budget.
  if (skills.length > 0) {
    const lines = renderSkillListing(
      skills,
      options?.skillsBudgetTokens,
      options?.countText ?? ((t: string) => Math.ceil(t.length / 4)),
    );
    if (lines.length > 0) {
      parts.push('', '## Available Skills', ...lines);
    }
  }

  // Custom prompt
  if (options?.customPrompt) {
    parts.push('', options.customPrompt);
  }

  return parts.join('\n');
}
