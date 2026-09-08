import type { LLMProvider } from '../llm/provider.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolExecutionPipeline, ConfirmCallback } from '../tools/execution-pipeline.js';
import { AgentLoop } from '../agent/loop.js';
import { buildSystemPrompt } from '../agent/prompt.js';
import type { BuildPromptOptions } from '../agent/prompt.js';
import type { SkillRegistry } from '../skills/registry.js';
/** Model-resolution callback (catalog-driven; provided by the entrypoint). */
export type ModelSpecResolver = (spec: string) =>
  | { ok: true; llm: LLMProvider; model: string }
  | { ok: false; message: string };

/** Result of a subagent run. */
export interface SubagentResult {
  /** Final assistant text — the summary returned to the parent context. */
  summary: string;
  /** Number of LLM rounds consumed. */
  rounds: number;
  /** Stable id for this run (progress routing, transcript addressing). */
  agentId: string;
}

/** Progress event emitted while a subagent runs. */
export interface SubagentEvent {
  agentId: string;
  type: 'start' | 'tool_call' | 'tool_result' | 'end';
  /** Call / result / summary payload depending on type. */
  payload?: unknown;
  /** Round count (on end). */
  rounds?: number;
}

/** Dependencies for spawning subagents. */
export interface SubagentDeps {
  llm: LLMProvider;
  toolRegistry: ToolRegistry;
  toolExecutionPipeline: ToolExecutionPipeline;
  model: string;
  /** Max concurrently running subagents. Default 3. */
  maxConcurrent?: number;
  /** Environment facts, project instructions, learned memory — same source as the parent. */
  promptOptions?: BuildPromptOptions;
  /** Skill registry for progressive disclosure inside the subagent. */
  skills?: SkillRegistry;
  /** Subagent default model spec (routing tier 2). */
  defaultModel?: string;
  /** Catalog-driven model resolution (routing tier 1). */
  resolveModelSpec?: ModelSpecResolver;
  /** Progress sink for every spawned subagent (ticket 04). */
  onEvent?: (event: SubagentEvent) => void;
}

/** Options for a single subagent run. */
export interface SubagentRunOptions {
  /** Inherited user-confirmation callback for ask-level tools. */
  confirm?: ConfirmCallback;
  /** Max tool rounds for the subagent. Default 10. */
  maxRounds?: number;
  /** Per-invocation model spec (routing tier 1). */
  model?: string;
  /** Cancellation signal propagated into the subagent's tool execution. */
  signal?: AbortSignal;
}

const DEFAULT_MAX_ROUNDS = 10;
const DEFAULT_MAX_CONCURRENT = 3;

/** Tools never exposed to subagents (derivation guardrail). */
const CHILD_FORBIDDEN_TOOLS = new Set(['spawn_subagent']);

/**
 * Spawns subagents on demand.
 *
 * Mainstream pattern (Claude Code Task / Codex collaboration mode):
 *  - each subagent runs in a completely independent context window
 *  - it has its own system prompt and fresh message history
 *  - it inherits the tool set and the permission policy
 *  - only the final summary returns to the parent context
 */
export class SubagentSpawner {
  private readonly deps: SubagentDeps;
  /** Max concurrently running subagents (ticket 01 guardrail). */
  readonly maxConcurrent: number;
  private active = 0;
  private seq = 0;

  constructor(deps: SubagentDeps) {
    this.deps = deps;
    this.maxConcurrent = deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  }

  /**
   * Atomically acquire a concurrency slot (TOCTOU-safe under parallel
   * tool execution); false when the limit is reached.
   */
  private acquire(): boolean {
    if (this.active >= this.maxConcurrent) return false;
    this.active++;
    return true;
  }

  /** Build the child's tool registry: everything except the derivation tools. */
  private childToolRegistry(): ToolRegistry {
    const child = new ToolRegistry();
    for (const tool of this.deps.toolRegistry.getAll()) {
      if (!CHILD_FORBIDDEN_TOOLS.has(tool.name)) child.register(tool);
    }
    return child;
  }

  /** Run a focused task in a fresh subagent context. */
  async run(task: string, options?: SubagentRunOptions): Promise<SubagentResult> {
    if (!this.acquire()) {
      throw new Error(
        `Concurrent subagent limit reached (${this.active}/${this.maxConcurrent} running). ` +
          'Do not spawn more right now — retry after earlier subagents finish, or do the work directly.',
      );
    }
    const agentId = `sub-${Date.now().toString(36)}-${++this.seq}`;
    const emit = (event: Omit<SubagentEvent, 'agentId'>): void => {
      this.deps.onEvent?.({ agentId, ...event });
    };
    emit({ type: 'start', payload: task });
    try {
      // Model routing: per-call spec > configured default > parent model.
      let llm = this.deps.llm;
      let model = this.deps.model;
      let modelNote = '';
      const spec = options?.model ?? this.deps.defaultModel;
      if (spec && this.deps.resolveModelSpec) {
        const resolved = this.deps.resolveModelSpec(spec);
        if (resolved.ok) {
          llm = resolved.llm;
          model = resolved.model;
        } else {
          modelNote = ` (requested model "${spec}" unavailable: ${resolved.message} — fell back to ${model})`;
        }
      }

      // The loop builds its own frozen system prompt from promptOptions
      // (environment / project instructions / learned memory) and the skill
      // listing — same source and freeze semantics as the parent — and
      // progressive skill injection works because no prompt override is
      // passed (processUserInput keeps the injectSkills path alive).
      const maxRounds = options?.maxRounds ?? DEFAULT_MAX_ROUNDS;

      const loop = new AgentLoop({
        llm,
        abortSignal: options?.signal,
        toolRegistry: this.childToolRegistry(),
        toolExecutionPipeline: this.deps.toolExecutionPipeline,
        config: { maxToolRounds: maxRounds, model },
        promptOptions: {
          ...this.deps.promptOptions,
          customPrompt: [
            this.deps.promptOptions?.customPrompt,
            'You are a focused subagent completing a single task. Work autonomously, ' +
              'use the available tools, and finish with a concise summary of what you did ' +
              'and what you found. Do not ask the user questions.',
          ].filter(Boolean).join('\n\n'),
        },
        skills: this.deps.skills,
        onToken: () => {},
        onToolCall: (call) => emit({ type: 'tool_call', payload: call }),
        onToolResult: (result) => emit({ type: 'tool_result', payload: result }),
        onPermissionRequest: async (call) => options?.confirm
          ? options.confirm(call.function.name, safeParse(call.function.arguments))
          : false,
      });

      const turn = await loop.processUserInput(task);
      emit({ type: 'end', payload: turn.text, rounds: turn.rounds });

      const summary = turn.text.trim();
      return {
        summary: summary.length > 0
          ? summary + modelNote
          : 'Subagent did not complete within its round budget or produced no summary.' + modelNote,
        rounds: turn.rounds,
        agentId,
      };
    } finally {
      this.active--;
    }
  }
}

function safeParse(args: string): Record<string, unknown> {
  try {
    return JSON.parse(args) as Record<string, unknown>;
  } catch {
    return {};
  }
}
