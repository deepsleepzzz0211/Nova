import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, useInput } from 'ink';
import type { LLMProvider } from '../llm/provider.js';
import type { Message } from '../llm/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolExecutionPipeline } from '../tools/execution-pipeline.js';
import type { SessionStore } from '../agent/session.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { BuildPromptOptions } from '../agent/prompt.js';
import type { ThinkingLevel } from '../llm/compat.js';
import type { ModelCost } from '../llm/catalog.js';
import type { TodoState } from '../tools/todo.js';
import { useAgent, type UseAgentConfig } from './hooks/useAgent.js';
import { latestToolId } from './message-partition.js';
import { startBranchRefresh } from './git-branch.js';
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
  /** Provider name for the footer (optional). */
  providerName?: string;
  /** Model pricing for the footer cost estimate (optional). */
  modelCost?: ModelCost;
  /** Git branch shown in the footer (read once at startup). */
  gitBranch?: string | null;
  /** Fullscreen (alternate-screen) mode: transcript gets a fixed viewport. */
  fullscreen?: boolean;
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
  providerName,
  modelCost,
  gitBranch,
  fullscreen,
  listModels,
  resolveSwitch,
  model,
  maxToolRounds,
  mcpConnectionCount,
}: AppProps): React.ReactElement {
  const updateNotice = useUpdateNotice();
  const { messages, isStreaming, isThinking, staticEpoch, sendMessage, interrupt, pendingPermission, cacheStats, modelInfo, subagentActivity } = useAgent({
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
    providerName,
    modelCost,
    maxToolRounds,
  });

  // Follow-end: a new message snaps the fullscreen viewport back to the
  // newest content (pi-style), so streaming output is always visible.
  const lastMessageCount = useRef(messages.length);
  useEffect(() => {
    if (messages.length !== lastMessageCount.current) {
      lastMessageCount.current = messages.length;
      setScrollOffset(0);
    }
  }, [messages.length]);

  // Ctrl+O toggles the expanded state of the most recent tool block
  // (tui-refactor ticket 05): one global hotkey, no per-block input
  // handlers, no key competition with the editor.
  const [expandedToolIds, setExpandedToolIds] = useState<ReadonlySet<string>>(new Set());
  // Fullscreen transcript scroll: messages scrolled back from the newest.
  // Follow-end (0) is the default and stays sticky until the user scrolls up.
  const [scrollOffset, setScrollOffset] = useState(0);
  // The branch can change during a session (checkout in another terminal), so
  // refresh it on a slow timer instead of reading once at startup (#23).
  const [branch, setBranch] = useState<string | null>(gitBranch ?? null);
  useEffect(() => startBranchRefresh(setBranch), []);
  // Tool display kinds come from the registry (ticket 14); stable identity
  // so memoised message bubbles are not invalidated every render (ticket 08).
  const displayKind = useCallback(
    (n: string): 'command' | 'path' | undefined => toolRegistry.displayKindFor(n),
    [toolRegistry],
  );
  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === 'o') {
      const toolId = latestToolId(messages);
      setExpandedToolIds((prev) => {
        if (toolId === null) return prev;
        const next = new Set(prev);
        if (next.has(toolId)) next.delete(toolId);
        else next.add(toolId);
        return next;
      });
    }
    if (fullscreen && (key.pageUp || key.pageDown)) {
      // Scroll the transcript window by a page; the editor keeps the arrows.
      const page = Math.max(1, Math.floor((process.stdout.rows ?? 30) / 2));
      setScrollOffset((prev) => (key.pageUp ? prev + page : Math.max(0, prev - page)));
    }
  });

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <StatusBar
        model={modelInfo.model}
        workingDirectory={process.cwd()}
        gitBranch={branch}
        providerName={modelInfo.providerName}
        thinkingLevel={thinkingLevel}
        contextWindow={modelInfo.contextWindow}
        contextStrategy={contextStrategy}
        modelCost={modelInfo.cost}
        mcpConnectionCount={mcpConnectionCount}
        cacheStats={cacheStats}
        updateNotice={updateNotice ?? undefined}
        subagentActivity={subagentActivity}
      />

      {todoState && <TodoView todoState={todoState} />}

      <ChatView
        messages={messages}
        expandedToolIds={expandedToolIds}
        displayKind={displayKind}
        staticEpoch={staticEpoch}
        viewport={fullscreen ? { scrollOffset, terminalRows: process.stdout.rows ?? 30 } : undefined}
      />

      <PermissionDialog pending={pendingPermission} displayKind={displayKind} />

      <InputBar
        onSubmit={sendMessage}
        isStreaming={isStreaming}
        workingState={isThinking ? 'thinking' : isStreaming ? 'streaming' : 'idle'}
        onInterrupt={interrupt}
        modalOpen={pendingPermission !== null}
        onExit={() => process.exit(0)}
      />
    </Box>
  );
}
