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
import { PromptCacheMetrics } from '../../cache/prompt-cache-metrics.js';
import { runNpmUpdate } from '../../update/run-update.js';

/** A tool call as displayed in the UI. */
export interface DisplayToolCall {
  id: string;
  name: string;
  arguments: string;
  status: 'running' | 'done' | 'error';
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

/** Pending permission request awaiting user decision. */
export interface PendingPermission {
  call: ToolCall;
  resolve: (allow: boolean) => void;
}

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
  /** List models for the /model command (returns display text). */
  listModels?: () => string;
  /** Resolve a /model <spec> switch (loop application happens here). */
  resolveSwitch?: (spec: string) =>
    | { ok: true; llm: import('../../llm/provider.js').LLMProvider; model: string; contextWindow: number; providerName: string; message: string }
    | { ok: false; message: string };
  model: string;
  maxToolRounds: number;
}

/** Cache usage summary shown in the status bar (pi-style R/W/CH). */
export interface CacheStatsView {
  hitRate: number;
  latestHitRate: number;
  totalCachedTokens: number;
  totalCacheWriteTokens: number;
}

/** Return type of the useAgent hook. */
export interface UseAgentResult {
  messages: DisplayMessage[];
  isStreaming: boolean;
  sendMessage: (input: string) => void;
  /** Interrupt the in-flight LLM stream (Esc). */
  interrupt: () => void;
  pendingPermission: PendingPermission | null;
  /** Live prompt-cache metrics (R/W/CH). */
  cacheStats: CacheStatsView;
  /** Active model selection (updated by /model). */
  modelInfo: { model: string; contextWindow?: number; providerName: string };
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
  });
  const metricsRef = useRef(new PromptCacheMetrics());
  const [modelInfo, setModelInfo] = useState<{ model: string; contextWindow?: number; providerName: string }>({
    model: config.model,
    contextWindow: config.contextWindow,
    providerName: '',
  });

  // Ref to track the current assistant message being built during streaming
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
      if (!cur) return;
      const snap: DisplayMessage = {
        role: 'assistant',
        content: cur.content,
        toolCalls: [...cur.toolCalls],
        thinking: cur.thinking || undefined,
      };
      setMessages((prev) => {
        const withoutLast = prev.length > 0 && prev[prev.length - 1].role === 'assistant'
          ? prev.slice(0, -1)
          : prev;
        return [...withoutLast, snap];
      });
    }, 32);
  }
  const batcher = batcherRef.current;

  // Create the AgentLoop once
  if (loopRef.current === null) {
    const snapshot = (): DisplayMessage => ({
      role: 'assistant' as const,
      content: currentAssistantRef.current!.content,
      toolCalls: [...currentAssistantRef.current!.toolCalls],
      thinking: currentAssistantRef.current!.thinking || undefined,
    });

    const onToken = (token: string): void => {
      if (!currentAssistantRef.current) {
        currentAssistantRef.current = { content: '', toolCalls: [], thinking: '' };
      }
      currentAssistantRef.current.content += token;
      batcher.schedule();
    };

    const onThinking = (delta: string): void => {
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
      // Capture the snapshot synchronously (see batcher flush comment).
      const snap: DisplayMessage = {
        role: 'assistant',
        content: currentAssistantRef.current.content,
        thinking: currentAssistantRef.current.thinking || undefined,
        toolCalls: [...currentAssistantRef.current.toolCalls],
      };
      setMessages((prev) => {
        const withoutLast = prev.length > 0 && prev[prev.length - 1].role === 'assistant'
          ? prev.slice(0, -1)
          : prev;
        return [...withoutLast, snap];
      });
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
      // Capture the snapshot synchronously (see batcher flush comment).
      const cur = currentAssistantRef.current;
      const snap: DisplayMessage = {
        role: 'assistant',
        content: cur.content,
        thinking: cur.thinking || undefined,
        toolCalls: [...cur.toolCalls],
      };
      setMessages((prev) => {
        const withoutLast = prev.length > 0 && prev[prev.length - 1].role === 'assistant'
          ? prev.slice(0, -1)
          : prev;
        return [...withoutLast, snap];
      });
    };

    const onPermissionRequest = (call: ToolCall): Promise<boolean> => {
      return new Promise<boolean>((resolve) => {
        setPendingPermission({ call, resolve });
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
          current.resolve(false);
        }
        return null;
      });
    };
  }, []);

  const sendMessage = useCallback((input: string): void => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;

    const loop = loopRef.current;
    if (!loop) return;

    // Slash command: /update — npm i -g and report (takes effect on restart)
    if (trimmed === '/update') {
      setMessages((prev) => [...prev, { role: 'system' as const, content: 'checking for updates…' }]);
      void runNpmUpdate().then((r) => {
        setMessages((prev) => [...prev, { role: 'system' as const, content: r.message }]);
      });
      return;
    }

    // Slash command: /model [spec] — list or switch models
    if (trimmed === '/model' || trimmed.startsWith('/model ')) {
      const spec = trimmed === '/model' ? '' : trimmed.slice('/model '.length).trim();
      if (spec === '') {
        const listing = config.listModels?.() ?? 'No model catalog available.';
        setMessages((prev) => [...prev, { role: 'system' as const, content: listing }]);
        return;
      }
      const result = config.resolveSwitch?.(spec);
      if (result?.ok) {
        const loop = loopRef.current;
        if (loop) {
          loop.setProvider(result.llm);
          loop.setModel(result.model);
        }
        setModelInfo({ model: result.model, contextWindow: result.contextWindow, providerName: result.providerName });
      }
      setMessages((prev) => [...prev, { role: 'system' as const, content: result?.message ?? 'Model switching unavailable.' }]);
      return;
    }

    // Slash command: /undo [n] — revert the last n conversation turns
    // (conversation only; code changes are NOT reverted — check git).
    if (trimmed === '/undo' || trimmed.startsWith('/undo ')) {
      const arg = trimmed.slice('/undo'.length).trim();
      const n = Number.parseInt(arg, 10);
      const turns = Number.isFinite(n) && n >= 1 ? n : 1;
      setMessages((prev) => [...prev, { role: 'user' as const, content: trimmed }]);
      const result = loop.undoTurns(turns);
      if (result.undone) {
        // Rebuild the display from the reverted conversation
        const restored = loop
          .getMessages()
          .filter((msg): msg is { role: 'user' | 'assistant'; content: string } =>
            (msg.role === 'user' || msg.role === 'assistant') &&
            typeof msg.content === 'string' && msg.content.length > 0)
          .map((msg) => ({ role: msg.role, content: msg.content }));
        setMessages(restored);
        setMessages((prev) => [...prev, {
          role: 'system' as const,
          content: `[undone ${result.undoneTurns} turn(s) — conversation reverted; code changes are NOT reverted, check git status]`,
        }]);
      } else {
        setMessages((prev) => [...prev, { role: 'system' as const, content: '[nothing to undo]' }]);
      }
      return;
    }

    // Slash command: /compact — force a context compaction pass
    if (trimmed === '/compact') {
      setMessages((prev) => [...prev, { role: 'user' as const, content: '/compact' }]);
      void loop.compactNow().then((result) => {
        setMessages((prev) => [...prev, {
          role: 'system' as const,
          content: result.compacted
            ? `[context compacted: ${result.beforeTokens} → ${result.afterTokens} tokens]`
            : '[nothing to compact — context is small]',
        }]);
      });
      return;
    }

    // Add user message to display
    setMessages((prev) => [...prev, { role: 'user', content: trimmed }]);

    // Reset current assistant tracking
    currentAssistantRef.current = null;
    setIsStreaming(true);

    if (!loop) return;

    // Run the agent loop (fire-and-forget; state updates happen via callbacks)
    loop.processUserInput(trimmed).then(
      () => {
        // Force-flush any coalesced deltas, then start a fresh assistant
        // message for the next round (streaming ticket 06).
        batcher.flushNow();
        currentAssistantRef.current = null;
        setIsStreaming(false);
      },
      () => {
        batcher.flushNow();
        currentAssistantRef.current = null;
        setIsStreaming(false);
      },
    );
  }, [isStreaming]);

  return {
    messages,
    isStreaming,
    sendMessage,
    interrupt: () => loopRef.current?.interrupt(),
    pendingPermission,
    cacheStats,
    modelInfo,
    subagentActivity,
  };
}
