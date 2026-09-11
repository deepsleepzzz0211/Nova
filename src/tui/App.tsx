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
import type { ToolDisplay } from '../tools/types.js';
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
  /**
   * Everything the agent loop needs, passed straight through to useAgent
   * (ticket 18): one object instead of ~20 field-for-field copies that had to
   * be kept in sync with UseAgentConfig.
   */
  agent: UseAgentConfig;
  /** Number of active MCP server connections (footer). */
  mcpConnectionCount: number;
  /** Git branch shown in the footer (refreshed periodically). */
  gitBranch?: string | null;
  /** Fullscreen (alternate-screen) mode: transcript gets a fixed viewport. */
  fullscreen?: boolean;
  /** Shared todo state maintained by the todo_write tool (UI view). */
  todoState?: TodoState;
}
export function App({ agent, mcpConnectionCount, gitBranch, fullscreen, todoState }: AppProps): React.ReactElement {
  const updateNotice = useUpdateNotice();
  const { messages, isStreaming, isThinking, staticEpoch, sendMessage, interrupt, pendingPermission, cacheStats, modelInfo, subagentActivity } = useAgent(agent);

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
    (n: string): ToolDisplay | undefined => agent.toolRegistry.displayFor(n),
    [agent.toolRegistry],
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
        thinkingLevel={agent.thinkingLevel}
        contextWindow={modelInfo.contextWindow}
        contextStrategy={agent.contextStrategy}
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
