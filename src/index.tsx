#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import React from 'react';
import { render } from 'ink';
import { App } from './tui/App.js';
import { AgentLoop } from './agent/loop.js';
import { loadConfig, normalizeConfig, novaHome } from './config/loader.js';
import { providerRegistry } from './llm/registry.js';
import { loadModelCatalog, resolveModel, describeModels, parseModelSpec } from './llm/catalog.js';
import { readGitBranch } from './tui/git-branch.js';
import { formatStartupHeader } from './tui/header.js';
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
      'no-header': { type: 'boolean' },
      print: { type: 'string', short: 'p' },
      yes: { type: 'boolean' },
      thinking: { type: 'string' },
    },
    strict: false,
  });

  // Apply CLI overrides. A "provider/model" spec routes to that provider
  // (e.g. --model weixin/Deepseek-v4-flash), which keeps E2E invocations
  // self-contained without editing the user's config.
  if (values.model && typeof values.model === 'string') {
    const spec = values.model;
    if (spec.includes('/')) {
      const parsedSpec = parseModelSpec(spec, config.llm.provider || 'openai');
      if (parsedSpec.provider !== (config.llm.provider || 'openai')) {
        // Provider switch on the CLI: the configured endpoint/key belong to
        // the previous provider, so let the catalog supply both.
        config.llm.baseUrl = undefined;
        config.llm.apiKey = undefined;
      }
      config.llm.provider = parsedSpec.provider;
      config.llm.model = parsedSpec.model;
    } else {
      config.llm.model = spec;
    }
  }
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

  // Client identity sent on every provider request (e.g. OpenCode Go
  // requires a stable x-opencode-session per conversation + own UA).
  const defaultHeaders: Record<string, string> = {
    'User-Agent': `nova/${__NOVA_VERSION__}`,
    'x-opencode-session': randomUUID(),
  };

  // Initialize LLM provider by wire protocol (pi-style api layer)
  const llm = providerRegistry.getForApi(resolution.api, {
    name: resolution.name,
    apiKey: resolution.apiKey,
    baseUrl: resolution.baseUrl,
    model: resolution.model.id,
    defaultHeaders,
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
      defaultHeaders,
      compat: {
        supportsDeveloperRole: next.model.compat.supportsDeveloperRole,
        streamUsage: next.model.compat.streamUsage || config.llm.promptCache,
      },
      thinkingLevelMap: next.model.thinkingLevelMap,
      reasoning: next.model.reasoning,
    });

  // Shared spec resolution (used by /model and subagent model routing)
  const resolveSpec = (spec: string):
    | { ok: true; llm: LLMProvider; model: string; contextWindow: number; providerName: string; cost?: import('./llm/catalog.js').ModelCost }
    | { ok: false; message: string } => {
    try {
      const parsed = parseModelSpec(spec, selectionRef.provider);
      // Config-level base_url/api_key belong to the CONFIGURED provider: only
      // pass them when the spec stays on that provider, otherwise the request
      // would go to the wrong endpoint (e.g. switching to a catalog provider
      // while config.toml still points at opencode-go). Pre-existing bug found
      // while wiring E2E against a second provider.
      const sameProvider = parsed.provider === (config.llm.provider || 'openai');
      const next = resolveModel(
        {
          provider: parsed.provider,
          model: parsed.model,
          baseUrl: sameProvider ? config.llm.baseUrl : undefined,
          apiKey: sameProvider ? config.llm.apiKey : undefined,
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
        cost: next.model.cost,
      };
    } catch (err: unknown) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  };
  type SwitchResult =
    | { ok: true; llm: LLMProvider; model: string; contextWindow: number; providerName: string; message: string; cost?: import('./llm/catalog.js').ModelCost }
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
  const subagentLiveSink: { set?: (line: string | null) => void } = {};
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
        subagentLiveSink.set?.(null);
        subagentSink.notify?.(`[subagent ${event.agentId} finished: ${event.rounds} rounds]`);
      } else if (event.type === 'tool_call') {
        const call = event.payload as { function?: { name?: string } } | undefined;
        const tool = call?.function?.name ?? 'tool';
        subagentSink.notify?.(`[subagent ${event.agentId}] ▸ ${tool}`);
        subagentLiveSink.set?.(`${event.agentId} ▸ ${tool}`);
      } else if (event.type === 'tool_result') {
        const result = event.payload as { isError?: boolean } | undefined;
        subagentSink.notify?.(
          `[subagent ${event.agentId}] ${result?.isError ? '✗ tool error' : '✓ tool done'}`,
        );
        subagentLiveSink.set?.(`${event.agentId} ${result?.isError ? '✗' : '✓'} ${result?.isError ? 'error' : 'done'}`);
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

  // Non-interactive print mode (nova -p "prompt"): run one turn against the
  // configured provider, stream the answer to stdout and exit. Tool calls run
  // through the normal pipeline; without --yes, anything needing permission
  // is denied (no dialog is possible). Used by the E2E suite and scripts.
  const printPrompt = typeof values.print === 'string' ? values.print : null;
  if (printPrompt !== null) {
    const autoApprove = values.yes === true;
    let sawError = false;
    const loop = new AgentLoop({
      llm,
      toolRegistry,
      toolExecutionPipeline,
      session: sessionStore,
      skills: skillRegistry,
      promptOptions: {
        environment,
        projectInstructions,
        memory,
        customPrompt: config.agent.systemPrompt || undefined,
      },
      context: {
        maxTokens: resolution.model.contextWindow,
        reserveTokens: config.agent.contextReserveTokens,
        keepRecentTokens: config.agent.contextKeepRecentTokens,
        strategy: config.agent.contextStrategy as 'truncate' | 'compact',
      },
      streamIdleTimeoutMs: config.llm.streamIdleTimeoutMs,
      thinkingLevel: config.agent.thinkingLevel as import('./llm/compat.js').ThinkingLevel,
      config: { maxToolRounds: config.agent.maxToolRounds, model: config.llm.model },
      onToken: (token: string) => {
        // The loop reports failures as [Error: ...] tokens; print mode must
        // exit non-zero so scripts and the E2E suite can detect them.
        if (token.startsWith('[Error:')) sawError = true;
        process.stdout.write(token);
      },
      onToolCall: () => {},
      onToolResult: () => {},
      onThinking: () => {},
      onPermissionRequest: async () => autoApprove,
    });
    try {
      const result = await loop.processUserInput(printPrompt);
      if (result.text.length > 0 && !result.text.endsWith('\n')) process.stdout.write('\n');
      await mcpManager.stopAll();
      process.exit(0);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[error] ${msg}\n`);
      await mcpManager.stopAll();
      process.exit(1);
    }
  }

  // Startup header: printed ONCE before Ink takes over, so it lands in the
  // terminal scrollback and never costs a re-render (ticket 10). Disabled by
  // --no-header; print mode has no header.
  if (values['no-header'] !== true) {
    const skills = skillRegistry.findAll().map((skill) => skill.name);
    const contextFiles: string[] = [];
    if (projectInstructions !== undefined) contextFiles.push('AGENTS.md');
    if (memory !== undefined && memory.trim() !== '') contextFiles.push('MEMORY.md');
    process.stdout.write(
      formatStartupHeader({
        version: __NOVA_VERSION__,
        model: resolution.model.id,
        provider: resolution.name,
        thinkingLevel: config.agent.thinkingLevel,
        contextFiles,
        skillNames: skills,
        mcpServers: config.mcpServers.map((server) => server.name),
        cwd: projectDir,
      }) + '\n\n',
    );
  }

  // Render TUI. Ink disables interactive mode when it detects CI (see
  // is-in-ci) or a non-TTY stdout, which is right for real users but makes
  // the PTY-based E2E suite impossible: the frame is written once and no key
  // event is processed. NOVA_FORCE_INTERACTIVE=1 is the explicit test seam
  // (the E2E harness sets it); normal runs pass undefined and keep Ink's
  // automatic detection.
  const forceInteractive = process.env.NOVA_FORCE_INTERACTIVE === '1';
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
      subagentLiveSink={subagentLiveSink}
      streamIdleTimeoutMs={config.llm.streamIdleTimeoutMs}
      contextKeepRecentTokens={config.agent.contextKeepRecentTokens}
      thinkingLevel={config.agent.thinkingLevel as import('./llm/compat.js').ThinkingLevel}
      providerName={resolution.name}
      modelCost={resolution.model.cost}
      gitBranch={readGitBranch(process.cwd())}
      model={config.llm.model}
      maxToolRounds={config.agent.maxToolRounds}
      mcpConnectionCount={mcpConnectionCount}
    />,
    forceInteractive ? { interactive: true } : undefined,
  );

  await waitUntilExit();
  await mcpManager.stopAll();
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
