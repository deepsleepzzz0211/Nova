#!/usr/bin/env node

/**
 * Composition root (p1-p2 10): parse → config → model runtime → session
 * startup → tool runtime → early exits → welcome → render. All the wiring
 * that accumulated here now lives in src/cli/* — this file only sequences
 * it, in the ORIGINAL startup order, so every side effect (file sweeps,
 * provider construction, MCP start) happens exactly where it used to.
 */
import * as path from 'node:path';
import React from 'react';
import { render } from 'ink';
import { App } from './tui/App.js';
import type { UseAgentConfig } from './tui/hooks/useAgent.js';
import { loadConfig, normalizeConfig, novaHome } from './config/loader.js';
import { readGitBranch } from './tui/git-branch.js';
import { formatWelcomeCard } from './tui/header.js';
import { parseCliArgs, applyCliOverrides } from './cli/args.js';
import { buildModelRuntime } from './cli/model-wiring.js';
import { runSessionStartup } from './cli/sessions.js';
import { buildToolRuntime, runPinSkills } from './cli/tools-runtime.js';
import { runPrintMode } from './cli/print-mode.js';

async function main(): Promise<void> {
  const projectDir = process.cwd();
  const { config, warnings: configWarnings } = normalizeConfig(loadConfig(projectDir));

  // Parse CLI arguments (highest priority)
  const values = parseCliArgs();

  // Version probe: print and exit before any session/provider work, so it
  // works without a TTY, a key, or a config (CI smoke checks rely on this).
  if (values.version === true) {
    console.log(__NOVA_VERSION__);
    process.exit(0);
  }

  if (typeof values['pin-skills'] === 'string') {
    runPinSkills(projectDir, values['pin-skills']);
  }

  applyCliOverrides(config, values);

  const model = buildModelRuntime(config);
  const llm = model.createProvider(model.resolution);

  // Startup hygiene: surface config warnings before the session sweeps
  // (original position, kept).
  for (const warning of configWarnings) {
    console.error(`[config] ${warning}`);
  }

  // Session persistence: --list prints sessions and exits; --resume picks
  // a session (interactive picker when several exist, latest otherwise).
  const session = await runSessionStartup(values);

  // Live model selection state (mutated by the /model command)
  const { resolution } = model;

  const runtime = await buildToolRuntime({
    config,
    llm,
    projectDir,
    subagentsDir: session.subagentsDir,
    resolveSpec: model.resolveSpec,
  });
  const { mcpManager, mcpConnectionCount } = runtime;

  const printPrompt = typeof values.print === 'string' ? values.print : null;
  if (printPrompt !== null) {
    await runPrintMode({
      printPrompt,
      autoApprove: values.yes === true,
      config,
      llm,
      resolution,
      runtime,
      session,
      mcpManager,
    });
  }

  // Welcome card (tui-redesign 06): rendered INSIDE the transcript (first
  // static item) instead of the old pre-Ink stdout header. Diagnostics about
  // what was loaded go to stderr (stdout is UI-owned now). --no-header hides
  // the card too.
  const skills = runtime.skillRegistry.findAll().map((skill) => skill.name);
  const contextFiles: string[] = [];
  if (runtime.projectInstructions !== undefined) contextFiles.push('AGENTS.md');
  if (runtime.memory !== undefined && runtime.memory.trim() !== '') contextFiles.push('MEMORY.md');
  {
    const loaded = [
      contextFiles.length > 0 ? `context: ${contextFiles.join(', ')}` : null,
      skills.length > 0 ? `skills (${skills.length}): ${skills.join(', ')}` : null,
      config.mcpServers.length > 0
        ? `mcp: ${config.mcpServers.map((server) => server.name).join(', ')}`
        : null,
    ].filter((line): line is string => line !== null);
    if (loaded.length > 0) process.stderr.write(`[session] ${loaded.join(' · ')}\n`);
  }
  const welcome =
    values['no-header'] === true
      ? undefined
      : formatWelcomeCard(
          {
            version: __NOVA_VERSION__,
            model: resolution.model.id,
            provider: resolution.name,
            cwd: projectDir,
            branch: readGitBranch(projectDir),
            mcpCount: mcpConnectionCount,
          },
          Math.floor(Date.now() / 60_000),
        );

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
    toolRegistry: runtime.toolRegistry,
    toolExecutionPipeline: runtime.toolExecutionPipeline,
    sessionStore: session.sessionStore,
    initialHistory: session.initialHistory,
    skills: runtime.skillRegistry,
    promptOptions: {
      environment: runtime.environment,
      projectInstructions: runtime.projectInstructions,
      memory: runtime.memory,
    },
    customPrompt: config.agent.systemPrompt || undefined,
    listModels: model.listModels,
    resolveSwitch: model.resolveSwitch,
    contextWindow: resolution.model.contextWindow,
    contextStrategy: config.agent.contextStrategy === 'compact' ? 'compact' : 'truncate',
    contextReserveTokens: config.agent.contextReserveTokens,
    contextKeepRecentTokens: config.agent.contextKeepRecentTokens,
    subagentSink: runtime.subagentSink,
    subagentLiveSink: runtime.subagentLiveSink,
    streamIdleTimeoutMs: config.llm.streamIdleTimeoutMs,
    thinkingLevel: config.agent.thinkingLevel as import('./llm/types.js').ThinkingLevel,
    providerName: resolution.name,
    modelCost: resolution.model.cost,
    model: config.llm.model,
    maxToolRounds: config.agent.maxToolRounds,
    statusExtras: () => {
      const branch = readGitBranch(process.cwd());
      const lines = [`cwd ${process.cwd()}${branch ? ` (${branch})` : ''}`];
      if (mcpConnectionCount > 0) lines.push(`${mcpConnectionCount} MCP server(s) connected`);
      return lines;
    },
  };

  const { waitUntilExit } = render(
    <App
      agent={agentConfig}
      todoState={runtime.todoState}
      welcome={welcome}
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
