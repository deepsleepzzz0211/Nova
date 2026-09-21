#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import React from 'react';
import { render } from 'ink';
import { App } from './tui/App.js';
import type { UseAgentConfig } from './tui/hooks/useAgent.js';
import { AgentLoop } from './agent/loop.js';
import { loadConfig, normalizeConfig, novaHome } from './config/loader.js';
import { loadModelCatalogWithEngine, resolveModel, describeModels, parseModelSpec } from './llm/catalog.js';
import { PiaiEngine } from './llm/piai-engine.js';
import { PiProvider } from './llm/providers/piai.js';
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
import { SKILL_LOCK_FILENAME, readSkillLock, writeSkillLock } from './skills/skill-lock.js';
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
      'tui-mode': { type: 'string' },
      print: { type: 'string', short: 'p' },
      yes: { type: 'boolean' },
      thinking: { type: 'string' },
      'pin-skills': { type: 'string' },
    },
    strict: false,
  });

  // Explicit integrity re-pin: hash every SKILL.md under the given repo dir
  // into a sibling lock file. Runs and exits before any session/model work.
  const pinSkillsDir = typeof values['pin-skills'] === 'string' ? values['pin-skills'] : null;
  if (pinSkillsDir !== null) {
    const target = path.resolve(projectDir, pinSkillsDir);
    try {
      // Preserve provenance: reuse the source already recorded at install.
      const existing = readSkillLock(path.join(target, SKILL_LOCK_FILENAME));
      const lock = writeSkillLock(target, existing?.source ?? 'manual');
      console.log(`pinned ${lock.skills.length} skill file(s) under ${target} (source: ${lock.source})`);
      process.exit(0);
    } catch (err: unknown) {
      console.error(`[skills-lock] ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

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

  // Model catalog: user-level models.json merged over built-in providers.
  // The catalog and the pi-ai engine are built together (ticket 01/03): the
  // engine is the runtime provider set the PiProviders stream through.
  const { catalog, engine } = loadModelCatalogWithEngine(new PiaiEngine(), [
    path.join(novaHome(), '.nova', 'models.json'),
  ]);
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

  /**
   * The ONLY place a provider instance is constructed (ticket 20): the
   * startup provider, /model switching and subagent routing all go through
   * this factory, so a new provider option is added exactly once.
   * Ticket 03 (pi-ai migration): every provider is now a PiProvider over
   * the shared engine's Models collection.
   */
  const createProvider = (next: import('./llm/catalog.js').ResolvedModel): LLMProvider =>
    new PiProvider({
      engine,
      provider: next.name,
      model: next.model.id,
      baseUrl: next.baseUrl,
      apiKey: next.apiKey,
      defaultHeaders,
      maxStreamRetries: config.llm.streamMaxRetries,
    });

  // Initialize LLM provider by wire protocol (pi-style api layer)
  const llm = createProvider(resolution);

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
  // /model switching and subagent routing share the startup factory above.
  const buildLlmProvider = createProvider;

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

  // Skills: scan user-level and project-level skill directories. Locked
  // repos (installed via the installer) are integrity-checked; drift/unpinned
  // skills are refused and surfaced on stderr, never silently loaded.
  const skillRegistry = new SkillRegistry();
  const skillWarn = (message: string): void => console.error(message);
  await skillRegistry.scan(path.join(novaHome(), '.nova', 'skills'), { onWarn: skillWarn });
  await skillRegistry.scan(path.join(projectDir, '.nova', 'skills'), { onWarn: skillWarn });

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
      // Context-policy observability: diagnostics go to stderr, never stdout
      // (stdout stays the requested answer only).
      onCompaction: (info) => {
        process.stderr.write(`[context] ${info.strategy} (${info.reason}): ${info.beforeTokens} -> ${info.afterTokens} tokens\n`);
      },
      onContextNote: (note) => {
        process.stderr.write(`[context] ${note}\n`);
      },
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
  // Fullscreen (alternate-screen) mode: fixed-viewport transcript with
  // PageUp/PageDown scrolling (ticket 12, route proven by the ticket-25
  // spike). Ink requires interactive mode for alternateScreen, so requesting
  // it forces interactive regardless of CI detection.
  const fullscreen = values['tui-mode'] === 'fullscreen';
  // One agent config object (ticket 18): App passes it straight to useAgent,
  // so a new option is declared in one place instead of being copied through
  // a props interface.
  const agentConfig: UseAgentConfig = {
    llm,
    toolRegistry,
    toolExecutionPipeline,
    sessionStore,
    initialHistory,
    skills: skillRegistry,
    promptOptions: { environment, projectInstructions, memory },
    customPrompt: config.agent.systemPrompt || undefined,
    listModels,
    resolveSwitch,
    contextWindow: resolution.model.contextWindow,
    contextStrategy: config.agent.contextStrategy === 'compact' ? 'compact' : 'truncate',
    contextReserveTokens: config.agent.contextReserveTokens,
    contextKeepRecentTokens: config.agent.contextKeepRecentTokens,
    subagentSink,
    subagentLiveSink,
    streamIdleTimeoutMs: config.llm.streamIdleTimeoutMs,
    thinkingLevel: config.agent.thinkingLevel as import('./llm/compat.js').ThinkingLevel,
    providerName: resolution.name,
    modelCost: resolution.model.cost,
    model: config.llm.model,
    maxToolRounds: config.agent.maxToolRounds,
  };

  const { waitUntilExit } = render(
    <App
      agent={agentConfig}
      todoState={todoState}
      mcpConnectionCount={mcpConnectionCount}
      gitBranch={readGitBranch(process.cwd())}
      fullscreen={fullscreen}
    />,
    fullscreen
      ? { alternateScreen: true, interactive: true }
      : forceInteractive
        ? { interactive: true }
        : undefined,
  );

  await waitUntilExit();
  await mcpManager.stopAll();
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
