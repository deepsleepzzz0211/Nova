/**
 * CLI argument surface (p1-p2 10, split out of index.tsx). parse + the
 * config-mutating override pass; the composition root calls these first and
 * keeps every early-exit in its original order so startup side effects are
 * byte-identical to the pre-split behavior.
 */
import { parseArgs } from 'node:util';
import type { AppConfig } from '../config/schema.js';
import { parseModelSpec } from '../llm/catalog.js';

export interface CliValues {
  model?: unknown;
  'api-key'?: unknown;
  'base-url'?: unknown;
  resume?: unknown;
  list?: unknown;
  'no-header'?: unknown;
  'tui-mode'?: unknown;
  print?: unknown;
  yes?: unknown;
  thinking?: unknown;
  'pin-skills'?: unknown;
  'replay-sessions'?: unknown;
  version?: unknown;
  _: unknown;
}

export function parseCliArgs(): CliValues {
  const { values } = parseArgs({
    options: {
      model: { type: 'string', short: 'm' },
      'api-key': { type: 'string' },
      'base-url': { type: 'string' },
      resume: { type: 'boolean', short: 'r' },
      list: { type: 'boolean' },
      'no-header': { type: 'boolean' },
      'tui-mode': { type: 'string' },
      print: { type: 'string', short: 'p' },
      yes: { type: 'boolean' },
      thinking: { type: 'string' },
      'pin-skills': { type: 'string' },
      'replay-sessions': { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
    },
    strict: false,
  });
  // strict:false gives an open bag; the interface documents the options we
  // declared above (values are read defensively at each use site).
  return values as unknown as CliValues;
}

/**
 * Apply CLI overrides. A "provider/model" spec routes to that provider
 * (e.g. --model weixin/Deepseek-v4-flash), which keeps E2E invocations
 * self-contained without editing the user's config.
 */
export function applyCliOverrides(config: AppConfig, values: CliValues): void {
  if (values.model && typeof values.model === 'string') {
    const spec = values.model;
    if (spec.includes('/')) {
      const parsedSpec = parseModelSpec(spec, config.llm.provider || 'openai');
      if (parsedSpec.provider !== (config.llm.provider || 'openai')) {
        // Provider switch on the CLI: the configured endpoint/key belong to
        // the previous provider, so let the catalog supply both.
        config.llm.baseUrl = undefined;
        config.llm.apiKey = undefined;
      }
      config.llm.provider = parsedSpec.provider;
      config.llm.model = parsedSpec.model;
    } else {
      config.llm.model = spec;
    }
  }
  if (values['api-key']) config.llm.apiKey = values['api-key'] as string;
  if (values['base-url']) config.llm.baseUrl = values['base-url'] as string;
  if (values.thinking && typeof values.thinking === 'string') config.agent.thinkingLevel = values.thinking;
}
