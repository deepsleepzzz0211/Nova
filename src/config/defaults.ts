import type { AppConfig } from './schema.js';

/** Sensible default configuration used when no config file exists. */
export const DEFAULT_CONFIG: AppConfig = {
  llm: {
    provider: 'openai',
    apiKey: '',
    // Empty by design: the wire URL comes from the model catalog
    // (BUILTIN_PROVIDERS / models.json), so a config default must not
    // mask a declared provider baseUrl.
    baseUrl: '',
    model: 'gpt-4o',
    maxTokens: 4096,
    temperature: 0.7,
    streamIdleTimeoutMs: 60000,
    streamMaxRetries: 1,
  },
  agent: {
    maxToolRounds: 50,
    systemPrompt: '',
    contextStrategy: 'truncate',
    contextReserveTokens: 16384,
    contextKeepRecentTokens: 20000,
    subagentModel: '',
    subagentMaxConcurrent: 3,
    thinkingLevel: 'off',
    skillsBudgetTokens: 2000,
  },
  search: {
    provider: 'tavily',
  },
  permission: {
    autoApproveFileWrite: false,
    autoApproveBash: false,
    alwaysAllowCommands: [],
  },
  mcpServers: [],
};
