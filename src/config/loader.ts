import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parse } from 'smol-toml';
import type { AppConfig, LLMConfig } from './schema.js';
import { DEFAULT_CONFIG } from './defaults.js';

/** Convert a snake_case string to camelCase. */
function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/** Recursively convert all object keys from snake_case to camelCase. */
function convertKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = snakeToCamel(key);
    if (Array.isArray(value)) {
      result[camelKey] = value.map((item) =>
        typeof item === 'object' && item !== null
          ? convertKeys(item as Record<string, unknown>)
          : item,
      );
    } else if (typeof value === 'object' && value !== null) {
      result[camelKey] = convertKeys(value as Record<string, unknown>);
    } else {
      result[camelKey] = value;
    }
  }
  return result;
}

/** Deep-merge source into target. Arrays in source replace target arrays. */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (
      typeof value === 'object' && value !== null && !Array.isArray(value) &&
      typeof result[key] === 'object' && result[key] !== null && !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Read and parse a TOML file, returning an empty object on any failure. */
function loadTomlFile(filePath: string): Record<string, unknown> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return convertKeys(parse(content) as Record<string, unknown>);
  } catch {
    return {};
  }
}

/**
 * Load application configuration by merging (lowest to highest priority):
 *   1. Built-in defaults
 *   2. User-level config  (<nova-home>/.nova/config.toml)
 *   3. Project-level config (projectDir/config.toml)
 *   4. Environment variables (NOVA_API_KEY, NOVA_MODEL, NOVA_BASE_URL)
 *      (legacy: CODEAGENT_API_KEY, CODEAGENT_MODEL, CODEAGENT_BASE_URL)
 *
 * The nova home directory defaults to os.homedir() and can be overridden
 * with the NOVA_HOME environment variable (test isolation / portable
 * installs).
 */
export function loadConfig(projectDir: string): AppConfig {
  const novaHome = process.env.NOVA_HOME || os.homedir();
  const userConfigPath = path.join(novaHome, '.nova', 'config.toml');
  const userConfig = loadTomlFile(userConfigPath);

  const projectConfigPath = path.join(projectDir, 'config.toml');
  const projectConfig = loadTomlFile(projectConfigPath);

  let merged = deepMerge(
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    userConfig,
  );
  merged = deepMerge(merged, projectConfig);

  // Environment variable overrides (highest priority)
  // Support both NOVA_* (preferred) and CODEAGENT_* (legacy) names
  const envLlm: Partial<LLMConfig> = {};
  const provider = process.env.NOVA_PROVIDER || process.env.CODEAGENT_PROVIDER;
  const apiKey = process.env.NOVA_API_KEY || process.env.CODEAGENT_API_KEY;
  const model = process.env.NOVA_MODEL || process.env.CODEAGENT_MODEL;
  const baseUrl = process.env.NOVA_BASE_URL || process.env.CODEAGENT_BASE_URL;
  if (provider) envLlm.provider = provider;
  if (apiKey) envLlm.apiKey = apiKey;
  if (model) envLlm.model = model;
  if (baseUrl) envLlm.baseUrl = baseUrl;

  if (Object.keys(envLlm).length > 0) {
    merged = deepMerge(merged, { llm: envLlm });
  }

  return merged as unknown as AppConfig;
}
