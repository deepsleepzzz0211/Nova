import type { AppConfig } from './schema.js';

/** Sensible default configuration used when no config file exists. */
export const DEFAULT_CONFIG: AppConfig = {
  llm: {
    provider: 'openai',
    apiKey: '',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    maxTokens: 4096,
    temperature: 0.7,
    promptCache: false,
  },
  agent: {
    maxToolRounds: 50,
    systemPrompt: '',
    contextStrategy: 'truncate',
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
