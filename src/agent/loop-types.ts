import type { LLMProvider } from '../llm/provider.js';
import type { ToolCall, ThinkingLevel } from '../llm/types.js';
import type { ToolResult } from '../tools/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolExecutionPipeline } from '../tools/execution-pipeline.js';
import type { SessionWriter } from './session.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { BuildPromptOptions } from './prompt.js';
import type { TurnUsage } from '../cache/prompt-cache-metrics.js';

/**
 * AgentLoop configuration/result types (p1-p2 12, split out of loop.ts).
 * loop.ts re-exports every name so all historical import paths hold.
 */

/** Result of a single user-input turn. */
export interface AgentTurnResult {
  /** Final assistant text (empty when the turn ended without text). */
  text: string;
  /** Number of LLM rounds consumed. */
  rounds: number;
}

/** Why a context-management pass ran (or the notice that replaced it). */
export type ContextDecisionReason = 'pressure' | 'idle' | 'manual' | 'overflow';

/** Context management configuration. */
export interface LoopContextConfig {
  /** Model context window size. */
  maxTokens: number;
  /** Tokens reserved for the LLM response (trigger = window − reserve). Default 16384. */
  reserveTokens?: number;
  /** Recent tokens kept verbatim during compaction. Default 20000. */
  keepRecentTokens?: number;
  /** What to do when the budget is approached: drop old messages or summarize. */
  strategy: 'truncate' | 'compact';
  /**
   * Microcompact (zero-LLM clearing of old tool results) also runs when the
   * conversation has been idle this long without pressure. Default 60 min.
   */
  microcompactIdleMs?: number;
}

/** Configuration for the AgentLoop. */
export interface AgentLoopConfig {
  llm: LLMProvider;
  toolRegistry: ToolRegistry;
  /** Single execution path for all tool invocations. */
  toolExecutionPipeline: ToolExecutionPipeline;
  config: { maxToolRounds: number; model: string };
  /** Optional context window management. */
  context?: LoopContextConfig;
  /** Optional JSONL session persistence. */
  session?: SessionWriter;
  /** Optional skill registry for progressive disclosure. */
  skills?: SkillRegistry;
  /** Extra system prompt parts (environment facts, project instructions, custom). */
  promptOptions?: BuildPromptOptions;
  /** Maximum matched skills whose full body is injected per turn. Default 2. */
  maxActiveSkills?: number;
  /** Notified after a compaction/truncation pass; reason codes the decision. */
  onCompaction?: (info: {
    strategy: 'truncate' | 'compact' | 'microcompact';
    beforeTokens: number;
    afterTokens: number;
    reason: ContextDecisionReason;
  }) => void;
  /**
   * Session-visible context-policy notices that change no tokens: circuit
   * breaker opening, rapid-refill suppression (zcode-borrow ticket 02).
   */
  onContextNote?: (note: string) => void;
  /** Notified once per turn with aggregated provider usage (cache metrics). */
  onUsage?: (usage: TurnUsage) => void;
  /**
   * Current context size in tokens (real count from the context manager, not
   * an estimate from provider usage). Reported after each round and after a
   * compaction, so the footer can show an accurate gauge (ticket 22).
   */
  onContextSize?: (tokens: number, triggerTokens: number) => void;
  /** Notified per thinking delta (reasoning stream, streaming ticket 03). */
  onThinking?: (delta: string) => void;
  /**
   * Notified once per tool call when its arguments are complete, just before
   * execution. The mid-stream onToolCall fires at tool_call_start with empty
   * arguments (ticket 04), so the UI uses this to fill in the summary.
   */
  onToolCallReady?: (call: ToolCall) => void;
  /** Unified thinking level forwarded to every chat call. */
  thinkingLevel?: ThinkingLevel;
  /** Cancellation signal: aborts in-flight tool execution (and future rounds). */
  abortSignal?: AbortSignal;
  /** LLM stream idle timeout (ms). Default 60000. */
  streamIdleTimeoutMs?: number;
  onToken: (token: string) => void;
  onToolCall: (call: ToolCall) => void;
  onToolResult: (result: ToolResult, callId?: string) => void;
  onPermissionRequest: (call: ToolCall) => Promise<boolean>;
}
