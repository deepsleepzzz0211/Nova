import { useState, useRef, useCallback, useEffect } from 'react';
import type { ToolCall, Message } from '../../llm/types.js';
import type { LLMProvider } from '../../llm/provider.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { ToolExecutionPipeline } from '../../tools/execution-pipeline.js';
import type { SessionStore } from '../../agent/session.js';
import type { SkillRegistry } from '../../skills/registry.js';
import type { BuildPromptOptions } from '../../agent/prompt.js';
import { AgentLoop } from '../../agent/loop.js';
import type { ThinkingLevel } from '../../llm/types.js';
import type { ModelCost } from '../../llm/catalog.js';
import { PromptCacheMetrics } from '../../cache/prompt-cache-metrics.js';
import { runNpmUpdate } from '../../update/run-update.js';
import { findCommand } from '../commands.js';
import { createCommandContext } from '../command-context.js';
import { formatStatusReport, type CompactionTotals } from '../status-format.js';
import { nextApprovalMode, toolClassOf, type ApprovalModeId } from '../approval-mode.js';

// UI display types live in a neutral module so the command/context layers
// can use them without importing React hooks (tui-refactor ticket 15 fixes).
import type {
  DisplayMessage,
  DisplayToolCall,
  DisplayModelInfo,
  CacheStatsView,
} from '../display-types.js';

export type { DisplayMessage, DisplayToolCall, DisplayModelInfo, CacheStatsView } from '../display-types.js';

// The streaming draft state machine and the approval pipeline were split
// out (p1-p2 11); PendingPermission moved with the gate and is re-exported
// so consumers (PermissionDialog, tests) keep importing it from here.
import { useAssistantStream, patchToolCall, setToolCallStatus as setToolCallStatusVia } from './assistant-stream.js';
import { createPermissionGate, type PendingPermission } from './permission-gate.js';

export type { PendingPermission } from './permission-gate.js';

/** Configuration for the useAgent hook. */
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
  /** Extra pre-rendered lines for the /status report (cwd/branch, MCP count). */
  statusExtras?: () => string[];
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

// CacheStatsView moved to display-types (tui-redesign review: break formatter cycle)

/** Return type of the useAgent hook. */
export interface UseAgentResult {
  messages: DisplayMessage[];
  isStreaming: boolean;
  /** Whether the model is emitting reasoning (thinking) deltas. */
  isThinking: boolean;
  /** Shift+Tab approval mode + its cycle entry point (tui-redesign 10). */
  approvalMode: ApprovalModeId;
  cycleApprovalMode: () => ApprovalModeId;
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
 * The streaming draft machine lives in ./assistant-stream, the approval
 * pipeline in ./permission-gate (p1-p2 11); this file sequences state,
 * loop wiring, commands, and rendering-facing output.
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
  // Session compaction totals for /status (cache-hit ticket 05); read at
  // report time, so no re-render is needed.
  const compactionTotalsRef = useRef<CompactionTotals>({ events: 0, reclaimedTokens: 0 });
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

  const [isThinking, setIsThinking] = useState(false);
  // Shift+Tab approval mode (tui-redesign 10): state for the badge, ref for
  // the async permission callback which must read the LATEST value.
  const [approvalMode, setApprovalMode] = useState<ApprovalModeId>('default');
  const approvalModeRef = useRef<ApprovalModeId>('default');
  const cycleApprovalMode = (): ApprovalModeId => {
    const next = nextApprovalMode(approvalModeRef.current);
    approvalModeRef.current = next;
    setApprovalMode(next);
    return next;
  };
  // Bumped whenever the displayed conversation is replaced wholesale (/undo):
  // Ink's static region is append-only and must be remounted to reprint.
  const [staticEpoch, setStaticEpoch] = useState(0);

  // Split-out concerns (p1-p2 11): streaming draft machine + approval gate.
  const stream = useAssistantStream(setMessages, setIsThinking);
  const { currentAssistantRef, batcher } = stream;
  const setToolCallStatus = (callId: string, status: DisplayToolCall['status']): void =>
    setToolCallStatusVia(setMessages, callId, status);
  // Tool display kinds come from the registry (ticket 14) — no hardcoded
  // tool names in the TUI layer.
  const kindOf = (n: string): import('../../tools/types.js').ToolDisplay | undefined =>
    config.toolRegistry.displayFor(n);
  const onPermissionRequest = createPermissionGate({
    setMessages,
    setPendingPermission,
    setToolCallStatus,
    approvalModeRef,
    kindOf,
  });

  // Create the AgentLoop once
  const loopRef = useRef<AgentLoop | null>(null);
  if (loopRef.current === null) {
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
      onToken: stream.onToken,
      onToolCall: stream.onToolCall,
      onToolCallReady: (call: ToolCall) =>
        patchToolCall(setMessages, call.id, { arguments: call.function.arguments }),
      onToolResult: stream.onToolResult,
      onPermissionRequest,
      onThinking: stream.onThinking,
      onContextSize: (tokens, triggerTokens) => {
        setCacheStats((prev) => ({ ...prev, contextTokens: tokens, contextTriggerTokens: triggerTokens }));
      },
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
        // Net accumulation: a pass that GROWS the context subtracts rather
        // than being clamped to 0, which would hide regressions (review).
        compactionTotalsRef.current = {
          events: compactionTotalsRef.current.events + 1,
          reclaimedTokens:
            compactionTotalsRef.current.reclaimedTokens +
            (info.beforeTokens - info.afterTokens),
        };
        const label: Record<typeof info.strategy, string> = {
          compact: 'compacted',
          microcompact: 'micro-compacted',
          truncate: 'truncated',
        };
        setMessages((prev) => [...prev, {
          role: 'system' as const,
          content: `[context ${label[info.strategy]} (${info.reason}): ${info.beforeTokens} → ${info.afterTokens} tokens]`,
        }]);
      },
      onContextNote: (note) => {
        setMessages((prev) => [...prev, { role: 'system' as const, content: `[context] ${note}` }]);
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
  // from the spawner): tool activity → a live StatusLine line, start/end →
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
      batcher.dispose();
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
        buildStatusReport: () =>
          formatStatusReport({
            providerName: modelInfo.providerName,
            model: modelInfo.model,
            thinkingLevel: config.thinkingLevel,
            contextWindow: modelInfo.contextWindow,
            contextStrategy: config.contextStrategy,
            cacheStats,
            modelCost: modelInfo.cost,
            compaction: compactionTotalsRef.current,
            extras: config.statusExtras?.(),
          }),
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
    approvalMode,
    cycleApprovalMode,
    staticEpoch,
    sendMessage,
    interrupt: () => loopRef.current?.interrupt(),
    pendingPermission,
    cacheStats,
    modelInfo,
    subagentActivity,
  };
}
