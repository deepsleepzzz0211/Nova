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
import type { ThinkingLevel } from '../../llm/compat.js';
import { PromptCacheMetrics } from '../../cache/prompt-cache-metrics.js';

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
  /** Unified thinking level for reasoning-capable models. */
  thinkingLevel?: ThinkingLevel;
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
  pendingPermission: PendingPermission | null;
  /** Live prompt-cache metrics (R/W/CH). */
  cacheStats: CacheStatsView;
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

  // Ref to track the current assistant message being built during streaming
  const currentAssistantRef = useRef<{ content: string; toolCalls: DisplayToolCall[] } | null>(null);
  const loopRef = useRef<AgentLoop | null>(null);

  // Create the AgentLoop once
  if (loopRef.current === null) {
    const onToken = (token: string): void => {
      if (!currentAssistantRef.current) {
        currentAssistantRef.current = { content: '', toolCalls: [] };
      }
      currentAssistantRef.current.content += token;
      // Trigger re-render by updating messages with the latest snapshot
      setMessages((prev) => {
        const withoutLast = prev.length > 0 && prev[prev.length - 1].role === 'assistant'
          ? prev.slice(0, -1)
          : prev;
        return [...withoutLast, {
          role: 'assistant' as const,
          content: currentAssistantRef.current!.content,
          toolCalls: [...currentAssistantRef.current!.toolCalls],
        }];
      });
    };

    const onToolCall = (call: ToolCall): void => {
      if (!currentAssistantRef.current) {
        currentAssistantRef.current = { content: '', toolCalls: [] };
      }
      const displayCall: DisplayToolCall = {
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
        status: 'running',
      };
      currentAssistantRef.current.toolCalls.push(displayCall);
      setMessages((prev) => {
        const withoutLast = prev.length > 0 && prev[prev.length - 1].role === 'assistant'
          ? prev.slice(0, -1)
          : prev;
        return [...withoutLast, {
          role: 'assistant' as const,
          content: currentAssistantRef.current!.content,
          toolCalls: [...currentAssistantRef.current!.toolCalls],
        }];
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
      setMessages((prev) => {
        const withoutLast = prev.length > 0 && prev[prev.length - 1].role === 'assistant'
          ? prev.slice(0, -1)
          : prev;
        return [...withoutLast, {
          role: 'assistant' as const,
          content: currentAssistantRef.current!.content,
          toolCalls: [...currentAssistantRef.current!.toolCalls],
        }];
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
          ? { maxTokens: config.contextWindow, strategy: config.contextStrategy ?? 'truncate' }
          : undefined,
      thinkingLevel: config.thinkingLevel,
      config: { maxToolRounds: config.maxToolRounds, model: config.model },
      onToken,
      onToolCall,
      onToolResult,
      onPermissionRequest,
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

  // Clean up pending permission on unmount
  useEffect(() => {
    return () => {
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
        // After tool calls, start a fresh assistant message for the next round
        currentAssistantRef.current = null;
        setIsStreaming(false);
      },
      () => {
        currentAssistantRef.current = null;
        setIsStreaming(false);
      },
    );
  }, [isStreaming]);

  return { messages, isStreaming, sendMessage, pendingPermission, cacheStats };
}
