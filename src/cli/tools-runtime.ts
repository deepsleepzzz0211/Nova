/**
 * Tool/agent runtime assembly (p1-p2 10, split out of index.tsx): tool
 * registry + built-ins, permission pipeline, skills scan, environment/
 * memory prompt inputs, the subagent spawner with its UI sinks, and MCP
 * startup. The composition root consumes the returned bag as-is.
 */
import * as path from 'node:path';
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
import { createPowerShellTool, shouldRegisterPowerShell } from '../tools/powershell.js';
import { createWebSearchTool } from '../tools/web-search.js';
import { createWebFetchTool } from '../tools/web-fetch.js';
import { createTodoTool, type TodoState } from '../tools/todo.js';
import { SkillRegistry } from '../skills/registry.js';
import { SKILL_LOCK_FILENAME, readSkillLock, writeSkillLock } from '../skills/skill-lock.js';
import { SubagentSpawner } from '../subagent/spawner.js';
import { createSpawnSubagentTool } from '../subagent/tool.js';
import type { LLMProvider } from '../llm/provider.js';
import type { ResolveSpecResult } from './model-wiring.js';

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
  const toolExecutionPipeline = new ToolExecutionPipeline(new ToolResultCache(), permissionPolicy);

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
  // Windows-only native command channel (windows-shell 03); POSIX sessions
  // never see this tool at all.
  if (shouldRegisterPowerShell(os.platform())) {
    toolRegistry.register(createPowerShellTool());
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
