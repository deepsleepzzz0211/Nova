import { useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { ToolCall } from '../../llm/types.js';
import type { ToolResult } from '../../tools/types.js';
import { StreamBatcher } from '../stream-batcher.js';
import type { DisplayMessage, DisplayToolCall } from '../display-types.js';

/**
 * Streaming assistant-display state machine (p1-p2 11, split out of
 * useAgent): owns the draft message ref, the StreamBatcher coalescing, and
 * the loop's token/thinking/tool-call/result callbacks. useAgent wires the
 * returned handlers into AgentLoop; this module has no permission, command,
 * or cache concerns.
 */

/** Draft of the in-flight assistant message. */
export interface AssistantDraft {
  content: string;
  toolCalls: DisplayToolCall[];
  thinking: string;
  /** Thought timing for the `– Thought 4.2s` header (tui-redesign 09). */
  thinkingStartedAtMs?: number;
  thinkingEndedAtMs?: number;
}

/**
 * Replace the trailing assistant message with `snap` (leaving earlier
 * messages untouched). Shared by the batcher's flush and the loop callbacks
 * (ticket 16 — the same shape used to be written out three times).
 */
export function withAssistantSnapshot(prev: DisplayMessage[], snap: DisplayMessage): DisplayMessage[] {
  const withoutLast =
    prev.length > 0 && prev[prev.length - 1].role === 'assistant' ? prev.slice(0, -1) : prev;
  return [...withoutLast, snap];
}

/** Update one displayed tool call (status and/or arguments). */
export function patchToolCall(
  setMessages: Dispatch<SetStateAction<DisplayMessage[]>>,
  callId: string,
  patch: Partial<DisplayToolCall>,
): void {
  setMessages((prev) =>
    prev.map((m) =>
      m.role === 'assistant' && m.toolCalls !== undefined
        ? {
            ...m,
            toolCalls: m.toolCalls.map((tc) => (tc.id === callId ? { ...tc, ...patch } : tc)),
          }
        : m,
    ),
  );
}

export function setToolCallStatus(
  setMessages: Dispatch<SetStateAction<DisplayMessage[]>>,
  callId: string,
  status: DisplayToolCall['status'],
): void {
  // A run that starts (or restarts after a permission wait) re-baselines
  // its start time, so the row duration never counts user think-time.
  patchToolCall(setMessages, callId, status === 'running' ? { status, startedAtMs: Date.now() } : { status });
}

export interface AssistantStream {
  currentAssistantRef: MutableRefObject<AssistantDraft | null>;
  /** Immutable snapshot of the in-flight assistant message. */
  snapshot: () => DisplayMessage;
  /** Replace the trailing assistant display message with a snapshot. */
  commitAssistant: (snap: DisplayMessage) => void;
  onToken: (token: string) => void;
  onThinking: (delta: string) => void;
  onToolCall: (call: ToolCall) => void;
  onToolResult: (result: ToolResult, callId?: string) => void;
  batcher: StreamBatcher;
}

export function useAssistantStream(
  setMessages: Dispatch<SetStateAction<DisplayMessage[]>>,
  setIsThinking: (active: boolean) => void,
): AssistantStream {
  const currentAssistantRef = useRef<AssistantDraft | null>(null);

  /** One assistant-message snapshot (shared by batcher and event paths). */
  const assistantSnapshot = (cur: AssistantDraft): DisplayMessage => {
    let thinkingSeconds: number | undefined;
    if (cur.thinking !== '' && cur.thinkingStartedAtMs !== undefined && cur.thinkingEndedAtMs !== undefined) {
      thinkingSeconds = Math.max(0, (cur.thinkingEndedAtMs - cur.thinkingStartedAtMs) / 1000);
    }
    return {
      role: 'assistant' as const,
      content: cur.content,
      toolCalls: [...cur.toolCalls],
      thinking: cur.thinking || undefined,
      ...(thinkingSeconds === undefined ? {} : { thinkingSeconds }),
    };
  };

  // Token coalescing (streaming ticket 06): stream deltas mutate the ref;
  // at most one setState per window keeps long sessions from degrading.
  const batcherRef = useRef<StreamBatcher | null>(null);
  if (batcherRef.current === null) {
    batcherRef.current = new StreamBatcher(() => {
      // Snapshot NOW, synchronously: React defers state-updater execution
      // to the next render, by which time the turn may have ended and the
      // ref reset to null (crash: reading 'content' of null).
      const cur = currentAssistantRef.current;
      if (cur === null) return;
      const snap: DisplayMessage = assistantSnapshot(cur);
      setMessages((prev) => withAssistantSnapshot(prev, snap));
    }, 32);
  }
  const batcher = batcherRef.current;

  const snapshot = (): DisplayMessage => assistantSnapshot(currentAssistantRef.current!);

  const commitAssistant = (snap: DisplayMessage): void => {
    setMessages((prev) => withAssistantSnapshot(prev, snap));
  };

  const onToken = (token: string): void => {
    setIsThinking(false);
    if (!currentAssistantRef.current) {
      currentAssistantRef.current = { content: '', toolCalls: [], thinking: '' };
    }
    if (currentAssistantRef.current.thinking !== '' && currentAssistantRef.current.thinkingEndedAtMs === undefined) {
      currentAssistantRef.current.thinkingEndedAtMs = Date.now();
    }
    currentAssistantRef.current.content += token;
    batcher.schedule();
  };

  const onThinking = (delta: string): void => {
    setIsThinking(true);
    if (!currentAssistantRef.current) {
      currentAssistantRef.current = { content: '', toolCalls: [], thinking: '' };
    }
    if (currentAssistantRef.current.thinkingStartedAtMs === undefined) {
      currentAssistantRef.current.thinkingStartedAtMs = Date.now();
    }
    currentAssistantRef.current.thinking += delta;
    batcher.schedule();
  };

  const onToolCall = (call: ToolCall): void => {
    if (!currentAssistantRef.current) {
      currentAssistantRef.current = { content: '', toolCalls: [], thinking: '' };
    }
    if (currentAssistantRef.current.thinking !== '' && currentAssistantRef.current.thinkingEndedAtMs === undefined) {
      currentAssistantRef.current.thinkingEndedAtMs = Date.now();
    }
    const displayCall: DisplayToolCall = {
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      status: 'running',
      startedAtMs: Date.now(),
    };
    currentAssistantRef.current.toolCalls.push(displayCall);
    commitAssistant(snapshot());
  };

  const onToolResult = (result: ToolResult, callId?: string): void => {
    if (!currentAssistantRef.current) return;
    const calls = currentAssistantRef.current.toolCalls;
    // Match by call id when provided (parallel execution); fall back to
    // the last running call.
    let index = -1;
    if (callId !== undefined) {
      index = calls.findIndex((c) => c.id === callId);
    }
    if (index === -1) {
      for (let i = calls.length - 1; i >= 0; i--) {
        if (calls[i].status === 'running') {
          index = i;
          break;
        }
      }
    }
    if (index !== -1) {
      calls[index] = {
        ...calls[index],
        status: result.isError ? 'error' : 'done',
        result: result.content,
        endedAtMs: Date.now(),
      };
    }
    commitAssistant(snapshot());
  };

  return { currentAssistantRef, snapshot, commitAssistant, onToken, onThinking, onToolCall, onToolResult, batcher };
}
