import * as path from 'path';
import { AgentLoop } from '../agent/loop.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolExecutionPipeline } from '../tools/execution-pipeline.js';
import type { LLMProvider } from '../llm/provider.js';
import type { Message } from '../llm/types.js';
import type { Tool, ToolContext, ToolResult } from '../tools/types.js';
import { createReadFileTool } from '../tools/read-file.js';
import { createGrepTool } from '../tools/grep.js';
import { createGlobTool } from '../tools/glob.js';
import { errorMessage } from '../shared/errors.js';
import {
  createMemoryTool,
  formatMemoryIndex,
  readMemory,
  type MemoryTrees,
} from './store.js';
import type {
  ExtractionSnapshot,
  ExtractionStatus,
  MemoryExtractor,
} from './extraction-scheduler.js';

/**
 * The real memory-extraction executor (memory-v2 ticket 05; the ZCode
 * memory-agent discipline). Runs a dedicated subagent over ONLY the snapshot
 * window with a ≤5-round budget, confined to the memory trees: read_file /
 * grep / glob may touch nothing else, and the only writer is memory_write
 * (scope-routed, one-fact-per-file, update-in-place). The prompt carries the
 * existing indexes so duplicates UPDATE instead of spawning new topics, and
 * the turn discipline (parallel reads on turn 1, parallel writes on turn 2).
 * Extraction output takes effect in the NEXT session — the current system
 * prompt stays byte-frozen (cache philosophy).
 */

const DEFAULT_MAX_ROUNDS = 5;
const NOTHING_TO_SAVE = 'Nothing to save.';

/** Dependencies for {@link createMemoryExtractor}. */
export interface MemoryExtractorDeps {
  llm: LLMProvider;
  model: string;
  toolExecutionPipeline: ToolExecutionPipeline;
  /** The two memory trees; memory_write routes into them by scope. */
  trees: MemoryTrees;
  /** LLM round budget. Default 5. */
  maxRounds?: number;
  /** Visible-failure channel (one stderr line). Defaults to console.error. */
  onWarn?: (message: string) => void;
}

function normalizeAbs(p: string, cwd: string): string {
  return path.resolve(cwd, p).replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Is `raw` (relative or absolute) inside one of the memory trees? */
function isWithinTrees(raw: string, trees: MemoryTrees, cwd: string): boolean {
  const target = normalizeAbs(raw, cwd);
  return [trees.user, trees.project].some((dir) => {
    const base = normalizeAbs(dir, cwd);
    return target === base || target.startsWith(`${base}/`);
  });
}

/** Wrap a read tool so its `path` argument must name a memory-tree location. */
function confinedToTrees(tool: Tool, trees: MemoryTrees): Tool {
  return {
    ...tool,
    description: `${tool.description} (memory agent: the path argument MUST be inside a memory tree; anything else is denied)`,
    async execute(params, context, options): Promise<ToolResult> {
      const raw = params.path;
      if (typeof raw !== 'string' || raw === '' || !isWithinTrees(raw, trees, context.workingDirectory)) {
        return {
          content: `denied: the memory agent may only read inside the memory trees (${trees.user}, ${trees.project})`,
          isError: true,
        };
      }
      return tool.execute(params, context as ToolContext, options);
    },
  };
}

/** The extraction subagent's registry: three confined readers + memory_write. */
export function createMemoryAgentRegistry(trees: MemoryTrees): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(confinedToTrees(createReadFileTool(), trees));
  registry.register(confinedToTrees(createGrepTool(), trees));
  registry.register(confinedToTrees(createGlobTool(), trees));
  registry.register(createMemoryTool(trees));
  return registry;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`;
}

/** Render the window as plain transcript lines for the extraction prompt. */
function serializeWindow(window: readonly Message[]): string {
  return window
    .map((message) => {
      if (message.role === 'user') return `user: ${truncate(message.content, 4_000)}`;
      if (message.role === 'assistant') {
        const calls = (message.tool_calls ?? [])
          .map((call) => `${call.function.name}(${truncate(call.function.arguments, 300)})`)
          .join(', ');
        const text = message.content ?? '';
        return `assistant: ${truncate(text, 2_000)}${calls ? ` [called: ${calls}]` : ''}`;
      }
      if (message.role === 'tool') return `tool result: ${truncate(message.content, 1_200)}`;
      return `${message.role}: ${truncate(message.content, 1_200)}`;
    })
    .join('\n');
}

function indexBlock(label: string, dir: string): string {
  const index = formatMemoryIndex(readMemory(path.join(dir, 'MEMORY.md')));
  return `## ${label} tree — ${dir}\n${index === '' ? '(empty — no memories yet)' : index}`;
}

/** The full extraction instruction message (task), including the window. */
export function buildExtractionTask(
  trees: MemoryTrees,
  snapshot: ExtractionSnapshot,
  window: readonly Message[],
): string {
  return [
    `You are the memory extraction subagent. Analyze the ${window.length} conversation messages below and update the persistent memory to reflect any durable facts they reveal.`,
    '',
    'Rules:',
    '- Use ONLY the content of these messages. Do not verify anything against the repo, git, or the codebase — no source investigation turns.',
    '- Do not save what the repo, AGENTS.md, or git history already record, and no transient task state.',
    '- One fact per topic file. BEFORE writing, check the existing indexes below: if a topic already covers the fact, RE-USE its name with memory_write so it UPDATES in place instead of duplicating.',
    '- memory_write scope: "user" for personal preferences and machine-environment facts; "project" for team-shared conventions, commands, and constraints.',
    '- Turn discipline (you have at most 5 rounds): turn 1 — issue ALL read_file/grep calls in parallel for topics you might update; turn 2 — issue ALL memory_write calls in parallel. Do not interleave reads and writes across turns.',
    '- Your tools are CONFINED to the memory trees below; any path outside them is denied.',
    `- If nothing is worth saving, reply exactly: ${NOTHING_TO_SAVE}`,
    '',
    indexBlock('user', trees.user),
    '',
    indexBlock('project', trees.project),
    '',
    `## Recent conversation (${window.length} messages)`,
    serializeWindow(window),
  ].join('\n');
}

/**
 * Build the real executor for the ticket-04 scheduler seam. Never throws
 * upward: any failure becomes ONE visible warning and an 'error' status, so
 * the scheduler leaves the cursor untouched and the main turn is unaffected.
 */
export function createMemoryExtractor(deps: MemoryExtractorDeps): MemoryExtractor {
  const warn = deps.onWarn ?? ((message: string) => console.error(message));

  return async (snapshot: ExtractionSnapshot, window: readonly Message[]): Promise<ExtractionStatus> => {
    if (window.length === 0) return 'no-op';
    // The loop surfaces stream failures as [Error: ...] tokens (and an empty
    // final text); capture the token stream so a swallowed provider error is
    // still an honest 'error' status, not a fake success.
    let streamed = '';
    const loop = new AgentLoop({
      llm: deps.llm,
      toolRegistry: createMemoryAgentRegistry(deps.trees),
      toolExecutionPipeline: deps.toolExecutionPipeline,
      config: { maxToolRounds: deps.maxRounds ?? DEFAULT_MAX_ROUNDS, model: deps.model },
      // Background run: no UI sinks.
      onToken: (token) => {
        streamed += token;
      },
      onToolCall: () => undefined,
      onToolResult: () => undefined,
      // Every mutation the agent can perform lives inside the memory trees by
      // construction (confined readers + memory_write), so there is nothing
      // for a human to approve — the ask channel auto-approves within that
      // boundary only.
      onPermissionRequest: async () => true,
    });
    try {
      const turn = await loop.processUserInput(buildExtractionTask(deps.trees, snapshot, window));
      const text = turn.text.trim();
      if (streamed.includes('[Error:') || text.includes('[Error:')) {
        warn(`[memory] extraction failed: ${truncate(streamed || text, 300)}`);
        return 'error';
      }
      if (text === NOTHING_TO_SAVE || text.endsWith(NOTHING_TO_SAVE)) return 'no-op';
      return 'success';
    } catch (err: unknown) {
      warn(`[memory] extraction failed: ${errorMessage(err)}`);
      return 'error';
    }
  };
}
