/** LLM provider configuration. */
export interface LLMConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
  /** Enable provider prompt caching + usage reporting (OpenAI: stream_options). */
  promptCache: boolean;
  /** LLM stream idle timeout: error out when no chunk arrives for this long (ms). */
  streamIdleTimeoutMs?: number;
}

/** Agent behaviour configuration. */
export interface AgentConfig {
  maxToolRounds: number;
  systemPrompt: string;
  contextStrategy: string;
  /**
   * Tokens reserved for the LLM response when computing the compaction
   * trigger (contextWindow − reserveTokens). Default 16384.
   */
  contextReserveTokens?: number;
  /** Tokens of recent non-user messages kept verbatim during compaction. */
  contextKeepRecentTokens?: number;
  /** Default model spec for subagents (routing: call param > this > parent). */
  subagentModel?: string;
  /** Max concurrently running subagents. Default 3. */
  subagentMaxConcurrent?: number;
  /** Unified thinking level (off/minimal/low/medium/high/xhigh/max). */
  thinkingLevel: string;
}

/** Web search provider configuration. */
export interface SearchConfig {
  provider: 'tavily';
  tavilyApiKey?: string;
}

/** Permission and auto-approval settings. */
export interface PermissionConfig {
  autoApproveFileWrite: boolean;
  autoApproveBash: boolean;
  alwaysAllowCommands: string[];
}

/** Configuration for an MCP server. */
export interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  autoApprove?: boolean;
}

/** Top-level application configuration. */
export interface AppConfig {
  llm: LLMConfig;
  agent: AgentConfig;
  search: SearchConfig;
  permission: PermissionConfig;
  mcpServers: MCPServerConfig[];
}
