import React from 'react';
import { Box } from 'ink';
import type { LLMProvider } from '../llm/provider.js';
import type { Message } from '../llm/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolExecutionPipeline } from '../tools/execution-pipeline.js';
import type { SessionStore } from '../agent/session.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { BuildPromptOptions } from '../agent/prompt.js';
import type { ThinkingLevel } from '../llm/compat.js';
import type { TodoState } from '../tools/todo.js';
import { useAgent, type UseAgentConfig } from './hooks/useAgent.js';
import { useUpdateNotice } from './hooks/useUpdateNotice.js';
import { StatusBar } from './StatusBar.js';
import { ChatView } from './ChatView.js';
import { InputBar } from './InputBar.js';
import { PermissionDialog } from './PermissionDialog.js';
import { TodoView } from './TodoView.js';

/** Props for the App component. */
export interface AppProps {
  /** LLM provider instance. */
  llm: LLMProvider;
  /** Tool registry with all available tools. */
  toolRegistry: ToolRegistry;
  /** Tool execution pipeline with caching. */
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
  /** Shared todo state maintained by the todo_write tool. */
  todoState?: TodoState;
  /** Resolved model context window (drives context management). */
  contextWindow?: number;
  /** Context management strategy ('truncate' | 'compact'). */
  contextStrategy?: 'truncate' | 'compact';
  /** Tokens reserved for the LLM response (trigger = window − reserve). Default 16384. */
  contextReserveTokens?: number;
  /** Recent tokens kept verbatim during compaction. Default 20000 (context-compaction ticket 02). */
  contextKeepRecentTokens?: number;
  /** Subagent progress sink (useAgent assigns notify once mounted). */
  subagentSink?: { notify?: (message: string) => void };
  /** Live subagent activity sink (useAgent assigns set once mounted). */
  subagentLiveSink?: { set?: (line: string | null) => void };
  /** LLM stream idle timeout (ms). */
  streamIdleTimeoutMs?: number;
  /** Unified thinking level for reasoning-capable models. */
  thinkingLevel?: ThinkingLevel;
  /** List models for the /model command (returns display text). */
  listModels?: () => string;
  /** Resolve a /model <spec> switch (loop application happens in useAgent). */
  resolveSwitch?: UseAgentConfig['resolveSwitch'];
  /** Model name to display and use. */
  model: string;
  /** Maximum tool execution rounds per request. */
  maxToolRounds: number;
  /** Number of active MCP server connections. */
  mcpConnectionCount: number;
}

/**
 * Root TUI component composing StatusBar, ChatView, InputBar, and PermissionDialog.
 *
 * Manages global application state through the useAgent hook.
 */
export function App({
  llm,
  toolRegistry,
  toolExecutionPipeline,
  sessionStore,
  initialHistory,
  skills,
  promptOptions,
  customPrompt,
  todoState,
  contextWindow,
  contextStrategy,
  contextReserveTokens,
  contextKeepRecentTokens,
  subagentSink,
  subagentLiveSink,
  streamIdleTimeoutMs,
  thinkingLevel,
  listModels,
  resolveSwitch,
  model,
  maxToolRounds,
  mcpConnectionCount,
}: AppProps): React.ReactElement {
  const updateNotice = useUpdateNotice();
  const { messages, isStreaming, sendMessage, interrupt, pendingPermission, cacheStats, modelInfo, subagentActivity } = useAgent({
    llm,
    toolRegistry,
    toolExecutionPipeline,
    sessionStore,
    initialHistory,
    skills,
    promptOptions,
    customPrompt,
    contextWindow,
    contextStrategy,
    contextReserveTokens,
    contextKeepRecentTokens,
    subagentSink,
    subagentLiveSink,
    streamIdleTimeoutMs,
    thinkingLevel,
    listModels,
    resolveSwitch,
    model,
    maxToolRounds,
  });

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <StatusBar
        model={modelInfo.model}
        workingDirectory={process.cwd()}
        mcpConnectionCount={mcpConnectionCount}
        cacheStats={cacheStats}
        updateNotice={updateNotice ?? undefined}
        subagentActivity={subagentActivity}
      />

      {todoState && <TodoView todoState={todoState} />}

      <ChatView messages={messages} />

      <PermissionDialog pending={pendingPermission} />

      <InputBar
        onSubmit={sendMessage}
        isStreaming={isStreaming}
        onInterrupt={interrupt}
        onExit={() => process.exit(0)}
      />
    </Box>
  );
}
