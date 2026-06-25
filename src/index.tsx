#!/usr/bin/env node

import React from 'react';
import { render } from 'ink';
import { App } from './tui/App.js';
import { loadConfig } from './config/loader.js';
import { OpenAIProvider } from './llm/openai.js';
import { ToolRegistry } from './tools/registry.js';
import { MCPManager } from './mcp/manager.js';
import { createReadFileTool } from './tools/read-file.js';
import { createWriteFileTool } from './tools/write-file.js';
import { createEditFileTool } from './tools/edit-file.js';
import { createBashTool } from './tools/bash.js';
import { createWebSearchTool } from './tools/web-search.js';
import { createWebFetchTool } from './tools/web-fetch.js';

async function main(): Promise<void> {
  const projectDir = process.cwd();
  const config = loadConfig(projectDir);

  // Initialize LLM provider
  const llm = new OpenAIProvider({
    apiKey: config.llm.apiKey,
    baseUrl: config.llm.baseUrl,
  });

  // Initialize tool registry with built-in tools
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(createReadFileTool());
  toolRegistry.register(createWriteFileTool());
  toolRegistry.register(createEditFileTool());
  toolRegistry.register(createBashTool());
  toolRegistry.register(createWebSearchTool());
  toolRegistry.register(createWebFetchTool());

  // Start MCP servers
  const mcpManager = new MCPManager();
  let mcpConnectionCount = 0;

  if (config.mcpServers.length > 0) {
    await mcpManager.startAll(config.mcpServers);
    await mcpManager.registerTools(toolRegistry);
    mcpConnectionCount = config.mcpServers.length;
  }

  // Render TUI
  const { waitUntilExit } = render(
    <App
      llm={llm}
      toolRegistry={toolRegistry}
      model={config.llm.model}
      maxToolRounds={config.agent.maxToolRounds}
      mcpConnectionCount={mcpConnectionCount}
    />,
  );

  await waitUntilExit();
  await mcpManager.stopAll();
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
