import type { ModelCost } from '../llm/catalog.js';

/** A tool call as displayed in the UI. */
export interface DisplayToolCall {
  id: string;
  name: string;
  arguments: string;
  status: 'pending' | 'running' | 'done' | 'error';
  result?: string;
}

/** A message as displayed in the UI. */
export interface DisplayMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: DisplayToolCall[];
  /** Reasoning text accumulated before the visible content. */
  thinking?: string;
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
