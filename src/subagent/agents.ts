import * as fs from 'fs';
import * as path from 'path';
import { parse as parseToml } from 'smol-toml';

/**
 * Named agent definitions (batch-B ticket 05): TOML files in
 * `~/.nova/agents/<name>.toml` describe a constrained subagent — tool
 * whitelist, optional model, system prompt and the readOnly bit. Loading
 * mirrors the user-commands discipline: invalid files warn to stderr via the
 * injected callback and never block startup.
 */

/** One loaded agent definition. */
export interface AgentDefinition {
  /** File stem; kebab-case. */
  name: string;
  description: string;
  /** Tool whitelist — narrows the child registry, never widens it. */
  tools: string[];
  /** Model spec; absent inherits the normal routing tiers. */
  model?: string;
  /** Multiline system-prompt replacement for the child loop. */
  prompt: string;
  /** Derived bit: physically strip fileAccess=write capability tools. */
  readOnly: boolean;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * Parse one agent TOML file. Returns null (and lets the caller warn) for
 * invalid names, unparseable TOML, or missing/ill-typed required fields.
 */
export function parseAgentFile(
  fileName: string,
  content: string,
  warn: (message: string) => void = () => {},
): AgentDefinition | null {
  const name = fileName.replace(/\.toml$/, '');
  if (!NAME_RE.test(name)) {
    warn(`[agents] skipped ${fileName}: name must be kebab-case (${NAME_RE})`);
    return null;
  }
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(content) as Record<string, unknown>;
  } catch (err) {
    warn(`[agents] skipped ${fileName}: invalid TOML (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
  const { description, tools, model, prompt, readOnly } = raw;
  if (typeof description !== 'string' || description.trim() === '') {
    warn(`[agents] skipped ${fileName}: description must be a non-empty string`);
    return null;
  }
  if (!isStringArray(tools)) {
    warn(`[agents] skipped ${fileName}: tools must be an array of tool names`);
    return null;
  }
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    warn(`[agents] skipped ${fileName}: prompt must be a non-empty string`);
    return null;
  }
  if (model !== undefined && typeof model !== 'string') {
    warn(`[agents] skipped ${fileName}: model must be a string`);
    return null;
  }
  if (readOnly !== undefined && typeof readOnly !== 'boolean') {
    warn(`[agents] skipped ${fileName}: readOnly must be a boolean`);
    return null;
  }
  return {
    name,
    description: description.trim(),
    tools,
    ...(typeof model === 'string' && model.trim() !== '' ? { model: model.trim() } : {}),
    prompt: prompt.trim(),
    readOnly: readOnly === true,
  };
}

/** Load every valid definition from one directory (missing dir → empty map). */
export function loadAgentDefinitions(
  dir: string,
  warn: (message: string) => void = () => {},
): ReadonlyMap<string, AgentDefinition> {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return new Map();
  }
  const out = new Map<string, AgentDefinition>();
  for (const file of entries.filter((f) => f.endsWith('.toml')).sort()) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(dir, file), 'utf-8');
    } catch {
      warn(`[agents] skipped ${file}: unreadable`);
      continue;
    }
    const def = parseAgentFile(file, content, warn);
    if (def !== null) out.set(def.name, def);
  }
  return out;
}
