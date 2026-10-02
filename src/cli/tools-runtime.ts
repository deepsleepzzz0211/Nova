/**
 * Tool/agent runtime assembly (p1-p2 10, split out of index.tsx): tool
 * registry + built-ins, permission pipeline, skills scan, environment/
 * memory prompt inputs, the subagent spawner with its UI sinks, and MCP
 * startup. The composition root consumes the returned bag as-is.
 */
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { novaHome } from '../config/loader.js';
import type { AppConfig } from '../config/schema.js';
import { gatherEnvironment, loadProjectInstructions, type ShellFacts } from '../agent/environment.js';
import { resolveShellFromProcess, summarizeShellPlan, defaultShellProbe } from '../tools/shell-routing.js';
import { toSlashes } from '../shared/paths.js';
import { resolvePowerShell } from '../tools/powershell.js';
import { MCPManager } from '../mcp/manager.js';
import { readMemorySections, createMemoryTool } from '../memory/store.js';
import { PermissionPolicy } from '../permission/policy.js';
import { ToolResultCache } from '../cache/tool-result-cache.js';
import { ToolExecutionPipeline } from '../tools/execution-pipeline.js';
import { ToolRegistry } from '../tools/registry.js';
import { createReadFileTool } from '../tools/read-file.js';
import { createGrepTool } from '../tools/grep.js';
import { createGlobTool } from '../tools/glob.js';
import { createListDirTool } from '../tools/list-dir.js';
import { createWriteFileTool } from '../tools/write-file.js';
import { createEditFileTool } from '../tools/edit-file.js';
import { createBashTool } from '../tools/bash.js';
import { JobRegistry, createJobOutputTool, createJobKillTool } from '../tools/jobs.js';
import { killProcessTree } from '../tools/spawn-runner.js';
import { ShellSessionRegistry, type ShellProc } from '../tools/shell-session.js';
import { createPowerShellTool, shouldRegisterPowerShell } from '../tools/powershell.js';
import { createWebSearchTool } from '../tools/web-search.js';
import { createWebFetchTool } from '../tools/web-fetch.js';
import { createTodoTool, type TodoState } from '../tools/todo.js';
import { SkillRegistry } from '../skills/registry.js';
import { SKILL_LOCK_FILENAME, readSkillLock, writeSkillLock } from '../skills/skill-lock.js';
import { SubagentSpawner } from '../subagent/spawner.js';
import { loadAgentDefinitions } from '../subagent/agents.js';
import { planOsSandbox, takeNotice } from '../permission/os-sandbox.js';
import {
  defaultWinWrapDeps,
  probeWinWrap,
  ensureWrapper,
  grantRoots,
  restoreRoots,
  wrapInvocation,
} from '../tools/win-wrap.js';
import { createShellGate } from '../tools/win-smoke.js';
import type { SpawnInvocation } from '../tools/shell-routing.js';
import { createSpawnSubagentTool } from '../subagent/tool.js';
import type { LLMProvider } from '../llm/provider.js';
import type { ResolveSpecResult } from './model-wiring.js';
import { buildPipelineHooks } from '../hooks/config-hooks.js';
import { spawnHook } from './hook-spawner.js';

export interface ToolRuntime {
  toolRegistry: ToolRegistry;
  toolExecutionPipeline: ToolExecutionPipeline;
  skillRegistry: SkillRegistry;
  todoState: TodoState;
  subagentSink: { notify?: (message: string) => void };
  subagentLiveSink: { set?: (line: string | null) => void };
  mcpManager: MCPManager;
  mcpConnectionCount: number;
  environment: ReturnType<typeof gatherEnvironment>;
  projectInstructions: ReturnType<typeof loadProjectInstructions>;
  memory: string | undefined;
}

/**
 * Explicit integrity re-pin: hash every SKILL.md under the given repo dir
 * into a sibling lock file. Runs and exits before any session/model work.
 */
export function runPinSkills(projectDir: string, pinSkillsDir: string): never {
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

/** One-time interpreter facts for the system prompt (windows-shell 02). */
export function collectShellFacts(platform: NodeJS.Platform = os.platform()): ShellFacts {
  let facts: ShellFacts;
  try {
    const summary = summarizeShellPlan(resolveShellFromProcess());
    facts = { shell: summary.shell, ...(summary.note !== undefined ? { shellNote: summary.note } : {}) };
  } catch (err) {
    facts = {
      shell: `unresolved (${err instanceof Error ? err.message : String(err)})`,
      shellNote: 'The bash tool refuses to run until this is fixed — point NOVA_SHELL at a valid interpreter or unset it.',
    };
  }
  if (platform === 'win32') {
    const ps = resolvePowerShell(defaultShellProbe);
    facts.powershell = ps === null
      ? 'not found (powershell tool unavailable)'
      : `${ps.flavor === 'pwsh' ? 'pwsh 7' : 'Windows PowerShell'} available via the powershell tool (${toSlashes(ps.path)})`;
  }
  return facts;
}

/** Spawn one persistent session shell (bash-family only; ticket 07 spike). */
function spawnSessionShell(
  cwd: string,
  osWrap?: (inv: SpawnInvocation, cwd: string) => SpawnInvocation,
): ShellProc {
  const plan = resolveShellFromProcess();
  if (plan.kind !== 'bash') {
    throw new Error(`persistent sessions require a bash shell, got ${plan.label}`);
  }
  let file = plan.path;
  let args = ['--noediting', '--noprofile', '--norc'];
  if (osWrap !== undefined) {
    const wrapped = osWrap({ file, args }, cwd);
    file = wrapped.file;
    args = wrapped.args;
  }
  const child = spawn(file, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return child as unknown as ShellProc;
}

export async function buildToolRuntime(opts: {
  config: AppConfig;
  llm: LLMProvider;
  projectDir: string;
  subagentsDir: string;
  resolveSpec: (spec: string) => ResolveSpecResult;
}): Promise<ToolRuntime> {
  const { config, llm, projectDir, subagentsDir, resolveSpec } = opts;

  const permissionPolicy = new PermissionPolicy(config.permission, {
    // Tier-1 sandbox (ticket 01): inactive unless the user opts in via
    // [sandbox] workspace_write = false. The NOVA_HOME tree stays writable
    // (sessions, file-history, memory all live there).
    enabled: !config.sandbox.workspaceWrite,
    workspaceRoot: projectDir,
    allowRoots: [path.join(novaHome(), '.nova')],
  });
  // Declarative hooks (batch-B ticket 03): config [[hooks]] entries become
  // pipeline hooks through the CLI-owned spawner. Cast is config-boundary
  // shaped (schema owns validation at load).
  const toolExecutionPipeline = new ToolExecutionPipeline(new ToolResultCache(), permissionPolicy, {
    hooks: buildPipelineHooks(config.hooks, spawnHook),
  });

  // Skills: scan user-level and project-level skill directories. Locked
  // repos (installed via the installer) are integrity-checked; drift/unpinned
  // skills are refused and surfaced on stderr, never silently loaded.
  const skillRegistry = new SkillRegistry();
  const skillWarn = (message: string): void => console.error(message);
  await skillRegistry.scan(path.join(novaHome(), '.nova', 'skills'), { onWarn: skillWarn });
  await skillRegistry.scan(path.join(projectDir, '.nova', 'skills'), { onWarn: skillWarn });

  // Environment facts + project instructions for the system prompt. Shell
  // facts are resolved ONCE here (DI glue; the agent layer stays free of
  // tools-value imports) and frozen into the prompt with the rest.
  const environment = gatherEnvironment(projectDir, {
    shellFacts: collectShellFacts(),
    ...(config.sandbox.workspaceWrite
      ? {}
      : { sandboxNote: `workspace-policy ON: writes outside ${projectDir} (except the nova home tree) are denied by policy` }),
  });
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
  toolRegistry.register(createGrepTool());
  toolRegistry.register(createGlobTool());
  toolRegistry.register(createListDirTool());
  toolRegistry.register(createWriteFileTool());
  toolRegistry.register(createEditFileTool());
  // Background jobs (ticket 06): in-process table for this session; the
  // full output of each job also lands in a per-job log under the home tree.
  // Job logs are ephemeral churn: keep them out of the NOVA_HOME tree (which
  // travels with the user and gets tier-2 ACL grants).
  const jobsLogDir = path.join(os.tmpdir(), 'nova-jobs');
  fs.mkdirSync(jobsLogDir, { recursive: true });
  const jobRegistry = new JobRegistry({
    logDir: jobsLogDir,
    terminate: (handle) => { if (handle.pid !== undefined) killProcessTree(handle.pid); },
  });
  // Tier-2 OS sandbox (ticket 02): win32 low-integrity wrap of every shell
  // child. Probe->plan->grant; ANY failure degrades to tier 1 with a
  // one-time stderr notice — the shell must always be able to start.
  let tier2: { wrap: (inv: SpawnInvocation, cwd: string) => SpawnInvocation } | undefined;
  if (config.sandbox.osLevel === 'auto') {
    const winDeps = defaultWinWrapDeps(novaHome());
    const plan = planOsSandbox(
      { osLevel: 'auto' },
      {
        workspaceRoot: projectDir,
        novaHome: path.join(novaHome(), '.nova'),
        tempDir: os.tmpdir(),
      },
      () => {
        const p = probeWinWrap(winDeps);
        if (!p.available) {
          return { platform: process.platform, wrapperAvailable: false, reason: p.reason };
        }
        const w = ensureWrapper(winDeps);
        return w.ok
          ? { platform: process.platform, wrapperAvailable: true }
          : { platform: process.platform, wrapperAvailable: false, reason: w.reason };
      },
    );
    // The enabled notice is only earned AFTER the grant lands — printing it
    // up front would green-light a sandbox that may never wrap anything.
    const notice = takeNotice(plan);
    if (!plan.enabled) {
      if (notice !== undefined) console.error(`[sandbox] ${notice}`);
    } else {
      const w = ensureWrapper(winDeps);
      if (!w.ok) {
        console.error(`[sandbox] tier-2 could not activate (${w.reason}) — continuing with tier-1 path policy only`);
      } else {
        const g = grantRoots(winDeps, plan.roots);
        if (!g.ok) {
          restoreRoots(winDeps);
          console.error(`[sandbox] tier-2 could not activate (grant failed on: ${g.failed.join(', ')}) — continuing with tier-1 path policy only`);
        } else {
          if (notice !== undefined) console.error(`[sandbox] ${notice}`);
          const gate = createShellGate(winDeps, w.exePath, plan.roots[0] ?? projectDir, (file, detail) => {
            console.error(`[sandbox] tier-2 not wrapping ${path.basename(file)} (${detail}) — that shell stays on tier-1 path policy`);
          });
          const exe = w.exePath;
          tier2 = { wrap: (inv, cwd) => (gate(inv.file) ? wrapInvocation(exe, inv, cwd) : inv) };
          process.once('exit', () => restoreRoots(winDeps));
        }
      }
    }
  }

  // Named persistent shell sessions (ticket 07): one long-lived bash per
  // name, sentinel-framed. The shells die with the process by contract.
  const shellSessions = new ShellSessionRegistry({
    idleMs: config.agent.shellSessionIdleMs,
    spawn: ({ cwd }) => spawnSessionShell(cwd, tier2?.wrap),
  });
  process.once('exit', () => shellSessions.disposeAll());
  toolRegistry.register(createBashTool({ jobs: jobRegistry, sessions: shellSessions, osWrap: tier2?.wrap }));
  toolRegistry.register(createJobOutputTool(jobRegistry));
  toolRegistry.register(createJobKillTool(jobRegistry));
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
    // Named agent definitions (ticket 05): ~/.nova/agents/*.toml under the
    // NOVA_HOME tree; invalid files warn to stderr and are skipped.
    agents: loadAgentDefinitions(
      path.join(novaHome(), '.nova', 'agents'),
      (message) => process.stderr.write(`${message}
`),
    ),
    onEvent: (event) => {
      if (event.type === 'start') {
        const task = typeof event.payload === 'string' ? event.payload.slice(0, 80) : '';
        const who = event.agentName ?? event.agentId;
        subagentSink.notify?.(`[subagent ${who} started] ${task}`);
      } else if (event.type === 'end') {
        subagentLiveSink.set?.(null);
        subagentSink.notify?.(`[subagent ${event.agentId} finished: ${event.rounds} rounds]`);
      } else if (event.type === 'tool_call') {
        const call = event.payload as { function?: { name?: string } } | undefined;
        const tool = call?.function?.name ?? 'tool';
        subagentSink.notify?.(`[subagent ${event.agentId}] ▸ ${tool}`);
        subagentLiveSink.set?.(`${event.agentName ?? event.agentId} ▸ ${tool}`);
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
  // Windows-only native command channel (windows-shell 03); POSIX sessions
  // never see this tool at all.
  if (shouldRegisterPowerShell(os.platform())) {
    toolRegistry.register(createPowerShellTool({ osWrap: tier2?.wrap }));
  }

  // Start MCP servers
  const mcpManager = new MCPManager();
  let mcpConnectionCount = 0;
  if (config.mcpServers.length > 0) {
    await mcpManager.startAll(config.mcpServers);
    await mcpManager.registerTools(toolRegistry);
    mcpConnectionCount = config.mcpServers.length;
  }

  return {
    toolRegistry,
    toolExecutionPipeline,
    skillRegistry,
    todoState,
    subagentSink,
    subagentLiveSink,
    mcpManager,
    mcpConnectionCount,
    environment,
    projectInstructions,
    memory,
  };
}
