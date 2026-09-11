import { useState, useRef, useCallback, useEffect } from 'react';
import type { ToolCall, Message } from '../../llm/types.js';
import type { ToolResult } from '../../tools/types.js';
import type { LLMProvider } from '../../llm/provider.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { ToolExecutionPipeline } from '../../tools/execution-pipeline.js';
import type { SessionStore } from '../../agent/session.js';
import type { SkillRegistry } from '../../skills/registry.js';
import type { BuildPromptOptions } from '../../agent/prompt.js';
import { AgentLoop } from '../../agent/loop.js';
import { StreamBatcher } from '../stream-batcher.js';
import type { ThinkingLevel } from '../../llm/compat.js';
import type { ModelCost } from '../../llm/catalog.js';
import { PromptCacheMetrics } from '../../cache/prompt-cache-metrics.js';
import { runNpmUpdate } from '../../update/run-update.js';
import { SessionAlwaysRules, dangerReason, type PermissionDecision } from '../permission-display.js';
import { parseToolArgs } from '../tool-summary.js';
import { findCommand } from '../commands.js';
import { createCommandContext } from '../command-context.js';

// UI display types live in a neutral module so the command/context layers
// can use them without importing React hooks (tui-refactor ticket 15 fixes).
import type {
  DisplayMessage,
  DisplayToolCall,
  DisplayModelInfo,
} from '../display-types.js';

export type { DisplayMessage, DisplayToolCall, DisplayModelInfo } from '../display-types.js';

/** Pending permission request awaiting user decision. */
export interface PendingPermission {
  call: ToolCall;
  resolve: (decision: PermissionDecision) => void;
}

/** Configuration for the useAgent hook. */
/**
 * Replace the trailing assistant message with `snap` (leaving earlier
 * messages untouched). Shared by the batcher's flush and the loop callbacks
 * (ticket 16 — the same shape used to be written out three times).
 */
function withAssistantSnapshot(prev: DisplayMessage[], snap: DisplayMessage): DisplayMessage[] {
  const withoutLast =
    prev.length > 0 && prev[prev.length - 1].role === 'assistant' ? prev.slice(0, -1) : prev;
  return [...withoutLast, snap];
}

export interface UseAgentConfig {
  llm: LLMProvider;
  toolRegistry: ToolRegistry;
  toolExecutionPipeline: ToolExecutionPipeline;
  /** Optional JSONL session persistence. */
  sessionStore?: SessionStore;
  /** Conversation history to restore (--resume). */
  initialHistory?: Message[];
  /** Skill registry for progressive disclosure. */
  skills?: SkillRegistry;
  /** Extra system prompt parts (environment facts, project instructions). */
  promptOptions?: BuildPromptOptions;
  /** Extra prompt section from config. */
  customPrompt?: string;
  /** Resolved model context window (drives context management). */
  contextWindow?: number;
  /** Context management strategy ('truncate' | 'compact'). */
  contextStrategy?: 'truncate' | 'compact';
  /** Tokens reserved for the LLM response (trigger = window − reserve). Default 16384. */
  contextReserveTokens?: number;
  /** Recent tokens kept verbatim during compaction. Default 20000 (context-compaction ticket 02). */
  contextKeepRecentTokens?: number;
  /** Subagent progress sink (assign notify once mounted). */
  subagentSink?: { notify?: (message: string) => void };
  /** Live subagent activity sink (assign set once mounted; cleared on end). */
  subagentLiveSink?: { set?: (line: string | null) => void };
  /** LLM stream idle timeout (ms). */
  streamIdleTimeoutMs?: number;
  /** Unified thinking level for reasoning-capable models. */
  thinkingLevel?: ThinkingLevel;
  /** List models for the /model command (returns display text). */
  listModels?: () => string;
  /** Resolve a /model <spec> switch (loop application happens here). */
  resolveSwitch?: (spec: string) =>
    | { ok: true; llm: import('../../llm/provider.js').LLMProvider; model: string; contextWindow: number; providerName: string; cost?: import('../../llm/catalog.js').ModelCost; message: string }
    | { ok: false; message: string };
  model: string;
  /** Provider name for the footer (optional). */
  providerName?: string;
  /** Model pricing for the footer cost estimate (optional). */
  modelCost?: ModelCost;
  maxToolRounds: number;
}

/** Cache usage summary shown in the status bar (pi-style R/W/CH). */
export interface CacheStatsView {
  hitRate: number;
  latestHitRate: number;
  totalCachedTokens: number;
  totalCacheWriteTokens: number;
  /** Total prompt tokens seen this session (footer ↑). */
  totalInputTokens: number;
  /** Total completion tokens seen this session (footer ↓). */
  totalOutputTokens: number;
  /** Prompt size of the most recent request (current context usage). */
  contextTokens: number;
}

/** Return type of the useAgent hook. */
export interface UseAgentResult {
  messages: DisplayMessage[];
  isStreaming: boolean;
  /** Whether the model is emitting reasoning (thinking) deltas. */
  isThinking: boolean;
  /** Conversation epoch for the static region (bumped on wholesale replace). */
  staticEpoch: number;
  sendMessage: (input: string) => void;
  /** Interrupt the in-flight LLM stream (Esc). */
  interrupt: () => void;
  pendingPermission: PendingPermission | null;
  /** Live prompt-cache metrics (R/W/CH). */
  cacheStats: CacheStatsView;
  /** Active model selection (updated by /model). */
  modelInfo: { model: string; contextWindow?: number; providerName: string; cost?: ModelCost };
  /** Live subagent activity line (or null when idle). */
  subagentActivity: string | null;
}

/**
 * React hook that owns an AgentLoop instance and exposes conversation state.
 *
 * Manages display messages, streaming state, and permission requests.
 * The AgentLoop is created once and persists for the component lifetime.
 */
export function useAgent(config: UseAgentConfig): UseAgentResult {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null);
  const [cacheStats, setCacheStats] = useState<CacheStatsView>({
    hitRate: 0,
    latestHitRate: 0,
    totalCachedTokens: 0,
    totalCacheWriteTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    contextTokens: 0,
  });
  const metricsRef = useRef(new PromptCacheMetrics());
  const [modelInfo, setModelInfo] = useState<{
    model: string;
    contextWindow?: number;
    providerName: string;
    cost?: ModelCost;
  }>({
    model: config.model,
    contextWindow: config.contextWindow,
    providerName: config.providerName ?? '',
    cost: config.modelCost,
  });

  // Ref to track the current assistant message being built during streaming
  const [isThinking, setIsThinking] = useState(false);
  // Bumped whenever the displayed conversation is replaced wholesale (/undo):
  // Ink's static region is append-only and must be remounted to reprint.
  const [staticEpoch, setStaticEpoch] = useState(0);
  const currentAssistantRef = useRef<{ content: string; toolCalls: DisplayToolCall[]; thinking: string } | null>(null);
  const loopRef = useRef<AgentLoop | null>(null);

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
      const snap: DisplayMessage = {
        role: 'assistant',
        content: cur.content,
        toolCalls: [...cur.toolCalls],
        thinking: cur.thinking || undefined,
      };
      setMessages((prev) => withAssistantSnapshot(prev, snap));
    }, 32);
  }
  const batcher = batcherRef.current;

  // Create the AgentLoop once
  if (loopRef.current === null) {
    /** Immutable snapshot of the in-flight assistant message. */
    const snapshot = (): DisplayMessage => ({
      role: 'assistant' as const,
      content: currentAssistantRef.current!.content,
      toolCalls: [...currentAssistantRef.current!.toolCalls],
      thinking: currentAssistantRef.current!.thinking || undefined,
    });

    /**
     * Replace the trailing assistant message with `snap`. The snapshot is
     * taken synchronously by the caller: React defers updater execution, by
     * which time the ref may already be null (see the batcher comment).
     */
    const commitAssistant = (snap: DisplayMessage): void => {
      setMessages((prev) => withAssistantSnapshot(prev, snap));
    };

    const onToken = (token: string): void => {
      setIsThinking(false);
      if (!currentAssistantRef.current) {
        currentAssistantRef.current = { content: '', toolCalls: [], thinking: '' };
      }
      currentAssistantRef.current.content += token;
      batcher.schedule();
    };

    const onThinking = (delta: string): void => {
      setIsThinking(true);
      if (!currentAssistantRef.current) {
        currentAssistantRef.current = { content: '', toolCalls: [], thinking: '' };
      }
      currentAssistantRef.current.thinking += delta;
      batcher.schedule();
    };

    const onToolCall = (call: ToolCall): void => {
      if (!currentAssistantRef.current) {
        currentAssistantRef.current = { content: '', toolCalls: [], thinking: '' };
      }
      const displayCall: DisplayToolCall = {
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
        status: 'running',
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
        };
      }
      commitAssistant(snapshot());
    };

    /** Update one displayed tool call (status and/or arguments). */
    const patchToolCall = (callId: string, patch: Partial<DisplayToolCall>): void => {
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
    };

    const setToolCallStatus = (callId: string, status: DisplayToolCall['status']): void => {
      patchToolCall(callId, { status });
    };

    // Session-scoped always-allow rules (ticket 04): matching calls are
    // allowed without a dialog.
    // Tool display kinds come from the registry (ticket 14) — no hardcoded
    // tool names in the TUI layer.
    const kindOf = (n: string): 'command' | 'path' | undefined =>
      config.toolRegistry.displayKindFor(n);
    const alwaysRules = new SessionAlwaysRules();
    const onPermissionRequest = (call: ToolCall): Promise<boolean> => {
      // Ticket 05: show the awaiting-permission state on the tool block.
      setToolCallStatus(call.id, 'pending');
      const args = parseToolArgs(call.function.arguments);
      // Dangerous calls are never session-whitelisted: always-rules must
      // not short-circuit the dialog for them (review finding).
      if (dangerReason(call.function.name, args, kindOf) === null && alwaysRules.matches(call.function.name, args, kindOf)) {
        setToolCallStatus(call.id, 'running');
        return Promise.resolve(true);
      }
      return new Promise<boolean>((resolve) => {
        setPendingPermission({
          call,
          resolve: (decision: PermissionDecision) => {
            if (decision === 'always' && dangerReason(call.function.name, args, kindOf) === null) {
              alwaysRules.add(call.function.name, args, kindOf);
            }
            setToolCallStatus(call.id, 'running');
            resolve(decision !== 'deny');
          },
        });
      });
    };

    loopRef.current = new AgentLoop({
      llm: config.llm,
      toolRegistry: config.toolRegistry,
      toolExecutionPipeline: config.toolExecutionPipeline,
      session: config.sessionStore,
      skills: config.skills,
      promptOptions: { ...config.promptOptions, customPrompt: config.customPrompt },
      context:
        config.contextWindow !== undefined
          ? {
              maxTokens: config.contextWindow,
              reserveTokens: config.contextReserveTokens,
              keepRecentTokens: config.contextKeepRecentTokens,
              strategy: config.contextStrategy ?? 'truncate',
            }
          : undefined,
      thinkingLevel: config.thinkingLevel,
      streamIdleTimeoutMs: config.streamIdleTimeoutMs,
      config: { maxToolRounds: config.maxToolRounds, model: config.model },
      onToken,
      onToolCall,
      onToolCallReady: (call) => patchToolCall(call.id, { arguments: call.function.arguments }),
      onToolResult,
      onPermissionRequest,
      onThinking,
      onUsage: (usage) => {
        metricsRef.current.record(usage);
        const m = metricsRef.current;
        setCacheStats({
          hitRate: m.hitRate,
          latestHitRate: m.latestHitRate,
          totalCachedTokens: m.totalCachedTokens,
          totalCacheWriteTokens: m.totalCacheWriteTokens,
          totalInputTokens: m.totalInputTokens,
          totalOutputTokens: m.totalOutputTokens,
          contextTokens: m.lastInputTokens,
        });
      },
      onCompaction: (info) => {
        setMessages((prev) => [...prev, {
          role: 'system' as const,
          content: `[context ${info.strategy === 'compact' ? 'compacted' : 'truncated'}: ${info.beforeTokens} → ${info.afterTokens} tokens]`,
        }]);
      },
    });

    if (config.initialHistory && config.initialHistory.length > 0) {
      loopRef.current.loadMessages(config.initialHistory);
      // Restore prior conversation into the display
      const restored = config.initialHistory
        .filter((msg): msg is { role: 'user' | 'assistant'; content: string } =>
          (msg.role === 'user' || msg.role === 'assistant') && typeof msg.content === 'string' && msg.content.length > 0)
        .map((msg) => ({ role: msg.role, content: msg.content }));
      if (restored.length > 0) {
        setMessages(restored);
      }
    }
  }

  // Wire the subagent progress sink once mounted (index.tsx feeds events
  // from the spawner): tool activity → a live StatusBar line, start/end →
  // system messages.
  const [subagentActivity, setSubagentActivity] = useState<string | null>(null);
  useEffect(() => {
    if (config.subagentSink) {
      config.subagentSink.notify = (message: string) => {
        setMessages((prev) => [...prev, { role: 'system' as const, content: message }]);
      };
    }
    if (config.subagentLiveSink) {
      config.subagentLiveSink.set = (line: string | null) => setSubagentActivity(line);
    }
  }, [config.subagentSink, config.subagentLiveSink]);

  // Clean up pending permission on unmount
  useEffect(() => {
    return () => {
      // Cancel any pending coalesced flush on unmount (ticket 06)
      batcherRef.current?.dispose();
      // Resolve any pending permission as denied on unmount
      setPendingPermission((current) => {
        if (current) {
          current.resolve('deny');
        }
        return null;
      });
    };
  }, []);

  /**
   * Resolve any permission request that is still pending when a turn ends
   * (interrupt, error, or completion): the dialog would otherwise stay on
   * screen forever and its promise would never settle (E2E finding).
   */
  const settleDanglingPermission = useCallback((): void => {
    setPendingPermission((current) => {
      current?.resolve('deny');
      return null;
    });
  }, []);

  const sendMessage = useCallback((input: string): void => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;

    const loop = loopRef.current;
    if (!loop) return;

    // Slash commands: single registry (ticket 15) — completion and dispatch
    // share one declaration; handlers receive UI callbacks here.
    const found = findCommand(trimmed);
    if (found !== null) {
      const ctx = createCommandContext({
        loop,
        listModels: config.listModels,
        resolveSwitch: config.resolveSwitch,
        updateMessages: (updater) => setMessages(updater),
        onConversationReplaced: () => setStaticEpoch((n) => n + 1),
        setModelInfo,
        runUpdate: runNpmUpdate,
      });
      const echoLine =
        found.args === '' ? `/${found.command.name}` : `/${found.command.name} ${found.args}`;
      // Handlers must not fail silently (AGENTS: error handling is
      // implemented, not deferred); the echo is appended AFTER the handler
      // so an /undo restore cannot swallow it.
      void Promise.resolve(found.command.run(ctx, found.args))
        .then(() => {
          if (found.command.echoesInput === true) ctx.appendUserMessage(echoLine);
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.appendSystemMessage(`[error] ${msg}`);
        });
      return;
    }

    // Add user message to display
    setMessages((prev) => [...prev, { role: 'user', content: trimmed }]);

    // Reset current assistant tracking
    currentAssistantRef.current = null;
    setIsStreaming(true);

    // Run the agent loop (fire-and-forget; state updates happen via callbacks)
    loop.processUserInput(trimmed).then(
      () => {
        // Force-flush any coalesced deltas, then start a fresh assistant
        // message for the next round (streaming ticket 06).
        batcher.flushNow();
        currentAssistantRef.current = null;
        setIsThinking(false);
        setIsStreaming(false);
        settleDanglingPermission();
      },
      (err: unknown) => {
        batcher.flushNow();
        currentAssistantRef.current = null;
        setIsThinking(false);
        setIsStreaming(false);
        // Errors must be visible, never swallowed (AGENTS: error handling
        // is implemented, not deferred).
        const msg = err instanceof Error ? err.message : String(err);
        setMessages((prev) => [...prev, { role: 'system' as const, content: `[error] ${msg}` }]);
        settleDanglingPermission();
      },
    );
  }, [isStreaming]);

  return {
    messages,
    isStreaming,
    isThinking,
    staticEpoch,
    sendMessage,
    interrupt: () => loopRef.current?.interrupt(),
    pendingPermission,
    cacheStats,
    modelInfo,
    subagentActivity,
  };
}
