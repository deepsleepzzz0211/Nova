import type { LLMProvider } from '../llm/provider.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolExecutionPipeline, ConfirmCallback } from '../tools/execution-pipeline.js';
import { AgentLoop } from '../agent/loop.js';
import { buildSystemPrompt } from '../agent/prompt.js';

/** Result of a subagent run. */
export interface SubagentResult {
  /** Final assistant text — the summary returned to the parent context. */
  summary: string;
  /** Number of LLM rounds consumed. */
  rounds: number;
}

/** Dependencies for spawning subagents. */
export interface SubagentDeps {
  llm: LLMProvider;
  toolRegistry: ToolRegistry;
  toolExecutionPipeline: ToolExecutionPipeline;
  model: string;
  /** Max concurrently running subagents. Default 3. */
  maxConcurrent?: number;
}

/** Options for a single subagent run. */
export interface SubagentRunOptions {
  /** Inherited user-confirmation callback for ask-level tools. */
  confirm?: ConfirmCallback;
  /** Max tool rounds for the subagent. Default 10. */
  maxRounds?: number;
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
    try {
      const systemPrompt = buildSystemPrompt(this.childToolRegistry().getAll(), [], {
        customPrompt:
          'You are a focused subagent completing a single task. Work autonomously, ' +
          'use the available tools, and finish with a concise summary of what you did ' +
          'and what you found. Do not ask the user questions.',
      });

      const maxRounds = options?.maxRounds ?? DEFAULT_MAX_ROUNDS;

      const loop = new AgentLoop({
        llm: this.deps.llm,
        toolRegistry: this.childToolRegistry(),
        toolExecutionPipeline: this.deps.toolExecutionPipeline,
        config: { maxToolRounds: maxRounds, model: this.deps.model },
        onToken: () => {},
        onToolCall: () => {},
        onToolResult: () => {},
        onPermissionRequest: async (call) => options?.confirm
          ? options.confirm(call.function.name, safeParse(call.function.arguments))
          : false,
      });

      const turn = await loop.processUserInputWithSystemPrompt(task, systemPrompt);

      const summary = turn.text.trim();
      return {
        summary: summary.length > 0
          ? summary
          : 'Subagent did not complete within its round budget or produced no summary.',
        rounds: turn.rounds,
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
