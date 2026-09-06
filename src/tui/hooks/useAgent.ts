import { useState, useRef, useCallback, useEffect } from 'react';
import type { ToolCall } from '../../llm/types.js';
import type { ToolResult } from '../../tools/types.js';
import type { LLMProvider } from '../../llm/provider.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { ToolExecutionPipeline } from '../../tools/execution-pipeline.js';
import { AgentLoop } from '../../agent/loop.js';

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
  role: 'user' | 'assistant';
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
  model: string;
  maxToolRounds: number;
}

/** Return type of the useAgent hook. */
export interface UseAgentResult {
  messages: DisplayMessage[];
  isStreaming: boolean;
  sendMessage: (input: string) => void;
  pendingPermission: PendingPermission | null;
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

    const onToolResult = (result: ToolResult): void => {
      if (!currentAssistantRef.current) return;
      const calls = currentAssistantRef.current.toolCalls;
      // Find the last running tool call and update it
      for (let i = calls.length - 1; i >= 0; i--) {
        if (calls[i].status === 'running') {
          calls[i] = {
            ...calls[i],
            status: result.isError ? 'error' : 'done',
            result: result.content,
          };
          break;
        }
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
      config: { maxToolRounds: config.maxToolRounds, model: config.model },
      onToken,
      onToolCall,
      onToolResult,
      onPermissionRequest,
    });
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

    // Add user message to display
    setMessages((prev) => [...prev, { role: 'user', content: trimmed }]);

    // Reset current assistant tracking
    currentAssistantRef.current = null;
    setIsStreaming(true);

    const loop = loopRef.current;
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

  return { messages, isStreaming, sendMessage, pendingPermission };
}
