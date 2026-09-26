/**
 * Tool/agent runtime assembly (p1-p2 10, split out of index.tsx): tool
 * registry + built-ins, permission pipeline, skills scan, environment/
 * memory prompt inputs, the subagent spawner with its UI sinks, and MCP
 * startup. The composition root consumes the returned bag as-is.
 */
import * as path from 'node:path';
import { novaHome } from '../config/loader.js';
import type { AppConfig } from '../config/schema.js';
import { gatherEnvironment, loadProjectInstructions } from '../agent/environment.js';
import { MCPManager } from '../mcp/manager.js';
import { readMemorySections, createMemoryTool } from '../memory/store.js';
import { PermissionPolicy } from '../permission/policy.js';
import { ToolResultCache } from '../cache/tool-result-cache.js';
import { ToolExecutionPipeline } from '../tools/execution-pipeline.js';
import { ToolRegistry } from '../tools/registry.js';
import { createReadFileTool } from '../tools/read-file.js';
import { createGrepTool } from '../tools/grep.js';
import { createWriteFileTool } from '../tools/write-file.js';
import { createEditFileTool } from '../tools/edit-file.js';
import { createBashTool } from '../tools/bash.js';
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

export async function buildToolRuntime(opts: {
  config: AppConfig;
  llm: LLMProvider;
  projectDir: string;
  subagentsDir: string;
  resolveSpec: (spec: string) => ResolveSpecResult;
}): Promise<ToolRuntime> {
  const { config, llm, projectDir, subagentsDir, resolveSpec } = opts;

  const permissionPolicy = new PermissionPolicy(config.permission);
  const toolExecutionPipeline = new ToolExecutionPipeline(new ToolResultCache(), permissionPolicy);

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
  toolRegistry.register(createGrepTool());
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
