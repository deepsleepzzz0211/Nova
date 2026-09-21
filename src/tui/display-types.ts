import type { ModelCost } from '../llm/catalog.js';

/** A tool call as displayed in the UI. */
export interface DisplayToolCall {
  id: string;
  name: string;
  arguments: string;
  status: 'pending' | 'running' | 'done' | 'error';
  result?: string;
  /** Wall-clock start (recorded by useAgent) for the row duration (tui-redesign 05). */
  startedAtMs?: number;
  /** Wall-clock end; duration shows only when both ends exist. */
  endedAtMs?: number;
}

/** A message as displayed in the UI. */
export interface DisplayMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: DisplayToolCall[];
  /** Reasoning text accumulated before the visible content. */
  thinking?: string;
  /** Seconds the thought ran, when both ends were observed (tui-redesign 09). */
  thinkingSeconds?: number;
}

/** Model info surfaced by the /model command. */
export interface DisplayModelInfo {
  model: string;
  contextWindow?: number;
  providerName: string;
  cost?: ModelCost;
}

/** Conversation entries (user/assistant only) restored after /undo. */
export interface RestoredMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Cache usage summary shown in the status line (pi-style R/W/CH). Lives
 * here (not in the hook) so pure formatters can type-depend on it without
 * importing React code (tui-redesign review: cycle break). */
export interface CacheStatsView {
  hitRate: number;
  latestHitRate: number;
  totalCachedTokens: number;
  totalCacheWriteTokens: number;
  /** Total prompt tokens seen this session (status ↑). */
  totalInputTokens: number;
  /** Total completion tokens seen this session (status ↓). */
  totalOutputTokens: number;
  /** Real context size in tokens (from the context manager). */
  contextTokens: number;
  /** Token budget at which automatic compaction triggers. */
  contextTriggerTokens?: number;
}
