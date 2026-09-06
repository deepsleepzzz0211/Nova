#!/usr/bin/env node

import { parseArgs } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import React from 'react';
import { render } from 'ink';
import { App } from './tui/App.js';
import { loadConfig } from './config/loader.js';
import { providerRegistry } from './llm/registry.js';
import type { Message } from './llm/types.js';
import { ToolRegistry } from './tools/registry.js';
import { MCPManager } from './mcp/manager.js';
import { SessionStore } from './agent/session.js';
import { createReadFileTool } from './tools/read-file.js';
import { createWriteFileTool } from './tools/write-file.js';
import { createEditFileTool } from './tools/edit-file.js';
import { createBashTool } from './tools/bash.js';
import { createWebSearchTool } from './tools/web-search.js';
import { createWebFetchTool } from './tools/web-fetch.js';
import { ToolResultCache } from './cache/tool-result-cache.js';
import { ToolExecutionPipeline } from './tools/execution-pipeline.js';
import { PermissionPolicy } from './permission/policy.js';

async function main(): Promise<void> {
  const projectDir = process.cwd();
  const config = loadConfig(projectDir);

  // Parse CLI arguments (highest priority)
  const { values } = parseArgs({
    options: {
      model: { type: 'string', short: 'm' },
      'api-key': { type: 'string' },
      'base-url': { type: 'string' },
      resume: { type: 'boolean', short: 'r' },
    },
    strict: false,
  });

  // Apply CLI overrides
  if (values.model && typeof values.model === 'string') config.llm.model = values.model;
  if (values['api-key']) config.llm.apiKey = values['api-key'] as string;
  if (values['base-url']) config.llm.baseUrl = values['base-url'] as string;

  // Initialize LLM provider using registry
  const llm = providerRegistry.getProvider({
    name: config.llm.provider || 'openai',
    apiKey: config.llm.apiKey,
    baseUrl: config.llm.baseUrl,
    model: config.llm.model,
  });

  // Initialize permission system
  const permissionPolicy = new PermissionPolicy(config.permission);

  // Initialize tool execution pipeline (single execution path)
  const toolExecutionPipeline = new ToolExecutionPipeline(new ToolResultCache(), permissionPolicy);

  // Session persistence: resume the latest session when requested
  const sessionsDir = path.join(os.homedir(), '.nova', 'sessions');
  let initialHistory: Message[] = [];
  if (values.resume) {
    const latest = SessionStore.findLatest(sessionsDir);
    if (latest) {
      initialHistory = SessionStore.load(latest);
    }
  }
  const sessionStore = SessionStore.create(sessionsDir);

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
      toolExecutionPipeline={toolExecutionPipeline}
      sessionStore={sessionStore}
      initialHistory={initialHistory}
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
