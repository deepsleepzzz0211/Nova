#!/usr/bin/env node

import { parseArgs } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import React from 'react';
import { render } from 'ink';
import { App } from './tui/App.js';
import { loadConfig, normalizeConfig, novaHome } from './config/loader.js';
import { providerRegistry } from './llm/registry.js';
import { loadModelCatalog, resolveModel, describeModels, parseModelSpec } from './llm/catalog.js';
import type { LLMProvider } from './llm/provider.js';
import type { Message } from './llm/types.js';
import { ToolRegistry } from './tools/registry.js';
import { MCPManager } from './mcp/manager.js';
import { SessionStore, SESSION_RETENTION_DAYS } from './agent/session.js';
import type { SessionSummary } from './agent/session.js';
import { SessionPicker, formatSessionList } from './tui/SessionPicker.js';
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
import { readMemorySections, createMemoryTool } from './memory/store.js';
import { ToolResultCache } from './cache/tool-result-cache.js';
import { ToolExecutionPipeline } from './tools/execution-pipeline.js';
import { PermissionPolicy } from './permission/policy.js';

async function main(): Promise<void> {
  const projectDir = process.cwd();
  const { config, warnings: configWarnings } = normalizeConfig(loadConfig(projectDir));

  // Parse CLI arguments (highest priority)
  const { values } = parseArgs({
    options: {
      model: { type: 'string', short: 'm' },
      'api-key': { type: 'string' },
      'base-url': { type: 'string' },
      resume: { type: 'boolean', short: 'r' },
      list: { type: 'boolean' },
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
  const catalog = loadModelCatalog([path.join(novaHome(), '.nova', 'models.json')]);
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

  // Session persistence: --list prints sessions and exits; --resume picks
  // a session (interactive picker when several exist, latest otherwise).
  const sessionsDir = path.join(novaHome(), '.nova', 'sessions');
  // Startup hygiene: surface config warnings, sweep stale files
  for (const warning of configWarnings) {
    console.error(`[config] ${warning}`);
  }
  const sweepAndReport = (dir: string, label: string): void => {
    const swept = SessionStore.sweep(dir, SESSION_RETENTION_DAYS);
    if (swept > 0) console.error(`[${label}] removed ${swept} stale file(s) older than ${SESSION_RETENTION_DAYS} days`);
  };
  sweepAndReport(sessionsDir, 'sessions');
  const subagentsDir = path.join(novaHome(), '.nova', 'subagents');
  sweepAndReport(subagentsDir, 'subagents');
  let initialHistory: Message[] = [];
  if (values.list) {
    const sessions = SessionStore.listSummaries(sessionsDir);
    console.log(formatSessionList(sessions));
    process.exit(0);
  }
  if (values.resume) {
    const sessions = SessionStore.listSummaries(sessionsDir);
    if (sessions.length === 0) {
      console.error('No previous sessions found in', sessionsDir);
    } else {
      let picked: SessionSummary | null = sessions[0]; // default: latest (previous behavior)
      if (sessions.length > 1 && process.stdin.isTTY) {
        picked = await new Promise<SessionSummary | null>((resolve) => {
          const { waitUntilExit } = render(
            <SessionPicker sessions={sessions} defaultIndex={0} onPick={resolve} />,
          );
          void waitUntilExit();
        });
      }
      if (!picked) {
        console.error('Resume cancelled.');
        process.exit(0);
      }
      initialHistory = SessionStore.load(picked.file);
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
  // Single construction site for catalog-resolved providers (used by
  // /model switching and subagent model routing).
  const buildLlmProvider = (next: import('./llm/catalog.js').ResolvedModel) =>
    providerRegistry.getForApi(next.api, {
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

  // Shared spec resolution (used by /model and subagent model routing)
  const resolveSpec = (spec: string):
    | { ok: true; llm: LLMProvider; model: string; contextWindow: number; providerName: string }
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
      const llmNext = buildLlmProvider(next);
      return {
        ok: true,
        llm: llmNext,
        model: next.model.id,
        contextWindow: next.model.contextWindow,
        providerName: next.name,
      };
    } catch (err: unknown) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  };
  type SwitchResult =
    | { ok: true; llm: LLMProvider; model: string; contextWindow: number; providerName: string; message: string }
    | { ok: false; message: string };
  const resolveSwitch = (spec: string): SwitchResult => {
    const result = resolveSpec(spec);
    if (result.ok) {
      selectionRef.provider = result.providerName;
      selectionRef.model = result.model;
      return { ...result, message: `Switched to ${result.providerName}/${result.model} (ctx ${result.contextWindow.toLocaleString()})` };
    }
    return result;
  };

  // Skills: scan user-level and project-level skill directories
  const skillRegistry = new SkillRegistry();
  await skillRegistry.scan(path.join(novaHome(), '.nova', 'skills'));
  await skillRegistry.scan(path.join(projectDir, '.nova', 'skills'));

  // Environment facts + project instructions for the system prompt
  const environment = gatherEnvironment(projectDir);
  const projectInstructions = loadProjectInstructions(projectDir);

  // Learned memory: user-level + project-level, read ONCE and frozen into
  // the system prompt for the whole session (cache philosophy).
  const memory = readMemorySections([
    path.join(novaHome(), '.nova', 'memory', 'MEMORY.md'),
    path.join(projectDir, '.nova', 'memory', 'MEMORY.md'),
  ]);

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
  toolRegistry.register(createMemoryTool(path.join(projectDir, '.nova', 'memory', 'MEMORY.md')));

  // Subagent spawner: lazy, independent-context delegation via spawn_subagent
  // Subagent progress sink: useAgent assigns the real notify() once the
  // TUI mounts; start/end events surface as system messages.
  const subagentSink: { notify?: (message: string) => void } = {};
  const spawner = new SubagentSpawner({
    llm,
    toolRegistry,
    toolExecutionPipeline,
    model: config.llm.model,
    maxConcurrent: config.agent.subagentMaxConcurrent,
    defaultModel: config.agent.subagentModel,
    resolveModelSpec: resolveSpec,
    transcriptsDir: subagentsDir,
    onEvent: (event) => {
      if (event.type === 'start') {
        const task = typeof event.payload === 'string' ? event.payload.slice(0, 80) : '';
        subagentSink.notify?.(`[subagent ${event.agentId} started] ${task}`);
      } else if (event.type === 'end') {
        subagentSink.notify?.(`[subagent ${event.agentId} finished: ${event.rounds} rounds]`);
      } else if (event.type === 'tool_call') {
        const call = event.payload as { function?: { name?: string } } | undefined;
        subagentSink.notify?.(`[subagent ${event.agentId}] ▸ ${call?.function?.name ?? 'tool'}`);
      } else if (event.type === 'tool_result') {
        const result = event.payload as { isError?: boolean } | undefined;
        subagentSink.notify?.(
          `[subagent ${event.agentId}] ${result?.isError ? '✗ tool error' : '✓ tool done'}`,
        );
      }
      // token events are forwarded to the sink API but not rendered as
      // messages (high-volume; available to future richer UI)
    },
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
      promptOptions={{ environment, projectInstructions, memory }}
      customPrompt={config.agent.systemPrompt || undefined}
      todoState={todoState}
      listModels={listModels}
      resolveSwitch={resolveSwitch}
      contextWindow={resolution.model.contextWindow}
      contextStrategy={config.agent.contextStrategy === 'compact' ? 'compact' : 'truncate'}
      contextReserveTokens={config.agent.contextReserveTokens}
      subagentSink={subagentSink}
      contextKeepRecentTokens={config.agent.contextKeepRecentTokens}
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
