import type { CacheRetention } from '../llm/types.js';

/** LLM provider configuration. */
export interface LLMConfig {
  provider: string;
  /** Optional: an unset value means "use the provider catalog default". */
  apiKey?: string;
  baseUrl?: string;
  model: string;
  maxTokens: number;
  temperature: number;
  /**
   * Provider prompt-cache retention (pi-ai `cacheRetention`): "short" = the
   * provider default (Anthropic ephemeral 5m), "long" = extended TTL where the
   * model supports it, "none" = disable explicit caching. Unset = provider
   * default path (pi-ai resolves "short").
   */
  cacheRetention?: CacheRetention;
  /** LLM stream idle timeout: error out when no chunk arrives for this long (ms). */
  streamIdleTimeoutMs?: number;
  /**
   * Transparent retries when a stream dies before real content lands
   * (stream-retry boundary). Default 1; 0 disables.
   */
  streamMaxRetries?: number;
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
  /**
   * Token ceiling for the Available-Skills listing in the system prompt.
   * Descriptions are truncated in order to fit; skills are never dropped by
   * the budget. Default 2000.
   */
  skillsBudgetTokens?: number;
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

/**
 * Sandbox configuration (batch-B ticket 01, gap G2 tier 1).
 * workspaceWrite=true (default) leaves the sandbox layer inactive —
 * today's approval-based behavior. false turns on the hard workspace path
 * policy: writes outside the workspace (plus the NOVA_HOME allow-list) are
 * DENIED by policy, not by dialog; always-allow rules cannot escape it.
 */
export interface SandboxConfig {
  workspaceWrite: boolean;
}

/**
 * One declarative hook entry ([[hooks]] array of TOML). The command receives
 * the event JSON on stdin; pre_tool_use denies via exit 2 or a
 * {"deny":true} stdout; post_tool_use stdout surfaces as a note (ticket 03).
 */
export interface HookConfig {
  event: 'pre_tool_use' | 'post_tool_use';
  /** Exact tool name or '*' for every tool. */
  matcher: string;
  command: string;
  timeoutMs?: number;
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
  sandbox: SandboxConfig;
  hooks: HookConfig[];
  mcpServers: MCPServerConfig[];
}
