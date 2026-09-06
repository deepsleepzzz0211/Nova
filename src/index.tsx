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
import { loadModelCatalog, resolveModel, describeModels, parseModelSpec } from './llm/catalog.js';
import type { LLMProvider } from './llm/provider.js';
import type { Message } from './llm/types.js';
import { ToolRegistry } from './tools/registry.js';
import { MCPManager } from './mcp/manager.js';
import { SessionStore } from './agent/session.js';
import { gatherEnvironment, loadProjectInstructions } from './agent/environment.js';
import { SkillRegistry } from './skills/registry.js';
import { SubagentSpawner } from './subagent/spawner.js';
import { createSpawnSubagentTool } from './subagent/tool.js';
import { createReadFileTool } from './tools/read-file.js';
import { createWriteFileTool } from './tools/write-file.js';
import { createEditFileTool } from './tools/edit-file.js';
import { createBashTool } from './tools/bash.js';
import { createWebSearchTool } from './tools/web-search.js';
import { createWebFetchTool } from './tools/web-fetch.js';
import { createTodoTool } from './tools/todo.js';
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
      thinking: { type: 'string' },
    },
    strict: false,
  });

  // Apply CLI overrides
  if (values.model && typeof values.model === 'string') config.llm.model = values.model;
  if (values['api-key']) config.llm.apiKey = values['api-key'] as string;
  if (values['base-url']) config.llm.baseUrl = values['base-url'] as string;
  if (values.thinking && typeof values.thinking === 'string') config.agent.thinkingLevel = values.thinking;

  // Model catalog: user-level models.json merged over built-in providers
  const catalog = loadModelCatalog([path.join(os.homedir(), '.nova', 'models.json')]);
  const resolution = resolveModel(
    {
      provider: config.llm.provider || 'openai',
      model: config.llm.model,
      baseUrl: config.llm.baseUrl,
      apiKey: config.llm.apiKey,
    },
    catalog,
  );

  // Initialize LLM provider by wire protocol (pi-style api layer)
  const llm = providerRegistry.getForApi(resolution.api, {
    name: resolution.name,
    apiKey: resolution.apiKey,
    baseUrl: resolution.baseUrl,
    model: resolution.model.id,
    // config.toml prompt_cache stays honored as a fallback
    compat: {
      supportsDeveloperRole: resolution.model.compat.supportsDeveloperRole,
      streamUsage: resolution.model.compat.streamUsage || config.llm.promptCache,
    },
    thinkingLevelMap: resolution.model.thinkingLevelMap,
    reasoning: resolution.model.reasoning,
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

  // Live model selection state (mutated by the /model command)
  const selectionRef = {
    provider: config.llm.provider || 'openai',
    model: config.llm.model,
  };

  // /model listing + resolution (catalog-driven; loop application in useAgent)
  const listModels = (): string => describeModels(catalog, selectionRef.provider, selectionRef.model);
  const resolveSwitch = (spec: string):
    | { ok: true; llm: LLMProvider; model: string; contextWindow: number; providerName: string; message: string }
    | { ok: false; message: string } => {
    try {
      const parsed = parseModelSpec(spec, selectionRef.provider);
      const next = resolveModel(
        {
          provider: parsed.provider,
          model: parsed.model,
          baseUrl: config.llm.baseUrl,
          apiKey: config.llm.apiKey,
        },
        catalog,
      );
      const llmNext = providerRegistry.getForApi(next.api, {
        name: next.name,
        apiKey: next.apiKey,
        baseUrl: next.baseUrl,
        model: next.model.id,
        compat: {
          supportsDeveloperRole: next.model.compat.supportsDeveloperRole,
          streamUsage: next.model.compat.streamUsage || config.llm.promptCache,
        },
        thinkingLevelMap: next.model.thinkingLevelMap,
        reasoning: next.model.reasoning,
      });
      selectionRef.provider = next.name;
      selectionRef.model = next.model.id;
      return {
        ok: true,
        llm: llmNext,
        model: next.model.id,
        contextWindow: next.model.contextWindow,
        providerName: next.name,
        message: `Switched to ${next.name}/${next.model.id} (ctx ${next.model.contextWindow.toLocaleString()}${next.model.reasoning ? ', reasoning' : ''})`,
      };
    } catch (err: unknown) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  };

  // Skills: scan user-level and project-level skill directories
  const skillRegistry = new SkillRegistry();
  await skillRegistry.scan(path.join(os.homedir(), '.nova', 'skills'));
  await skillRegistry.scan(path.join(projectDir, '.nova', 'skills'));

  // Environment facts + project instructions for the system prompt
  const environment = gatherEnvironment(projectDir);
  const projectInstructions = loadProjectInstructions(projectDir);

  // Initialize tool registry with built-in tools
  const toolRegistry = new ToolRegistry();
  const todoState = { todos: [] };
  toolRegistry.register(createReadFileTool());
  toolRegistry.register(createWriteFileTool());
  toolRegistry.register(createEditFileTool());
  toolRegistry.register(createBashTool());
  toolRegistry.register(createWebSearchTool({
    tavilyApiKey: config.search.tavilyApiKey,
  }));
  toolRegistry.register(createWebFetchTool());
  toolRegistry.register(createTodoTool(todoState));

  // Subagent spawner: lazy, independent-context delegation via spawn_subagent
  const spawner = new SubagentSpawner({
    llm,
    toolRegistry,
    toolExecutionPipeline,
    model: config.llm.model,
  });
  toolRegistry.register(createSpawnSubagentTool(spawner));

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
      skills={skillRegistry}
      promptOptions={{ environment, projectInstructions }}
      customPrompt={config.agent.systemPrompt || undefined}
      todoState={todoState}
      listModels={listModels}
      resolveSwitch={resolveSwitch}
      contextWindow={resolution.model.contextWindow}
      contextStrategy={config.agent.contextStrategy === 'compact' ? 'compact' : 'truncate'}
      thinkingLevel={config.agent.thinkingLevel as import('./llm/compat.js').ThinkingLevel}
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
