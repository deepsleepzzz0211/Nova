import React from 'react';
import { Box } from 'ink';
import type { LLMProvider } from '../llm/provider.js';
import type { ToolRegistry } from '../tools/registry.js';
import { useAgent } from './hooks/useAgent.js';
import { StatusBar } from './StatusBar.js';
import { ChatView } from './ChatView.js';
import { InputBar } from './InputBar.js';
import { PermissionDialog } from './PermissionDialog.js';

/** Props for the App component. */
export interface AppProps {
  /** LLM provider instance. */
  llm: LLMProvider;
  /** Tool registry with all available tools. */
  toolRegistry: ToolRegistry;
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
  model,
  maxToolRounds,
  mcpConnectionCount,
}: AppProps): React.ReactElement {
  const { messages, isStreaming, sendMessage, pendingPermission } = useAgent({
    llm,
    toolRegistry,
    model,
    maxToolRounds,
  });

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <StatusBar
        model={model}
        workingDirectory={process.cwd()}
        mcpConnectionCount={mcpConnectionCount}
      />

      <ChatView messages={messages} />

      <PermissionDialog pending={pendingPermission} />

      <InputBar onSubmit={sendMessage} isStreaming={isStreaming} />
    </Box>
  );
}
