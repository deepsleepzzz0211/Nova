import type { LLMProvider } from '../llm/provider.js';
import type { ToolRegistry } from '../tools/registry.js';
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
}

/** Options for a single subagent run. */
export interface SubagentRunOptions {
  /** Inherited user-confirmation callback for ask-level tools. */
  confirm?: ConfirmCallback;
  /** Max tool rounds for the subagent. Default 10. */
  maxRounds?: number;
}

const DEFAULT_MAX_ROUNDS = 10;

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

  constructor(deps: SubagentDeps) {
    this.deps = deps;
  }

  /** Run a focused task in a fresh subagent context. */
  async run(task: string, options?: SubagentRunOptions): Promise<SubagentResult> {
    const systemPrompt = buildSystemPrompt(this.deps.toolRegistry.getAll(), [], {
      customPrompt:
        'You are a focused subagent completing a single task. Work autonomously, ' +
        'use the available tools, and finish with a concise summary of what you did ' +
        'and what you found. Do not ask the user questions.',
    });

    const maxRounds = options?.maxRounds ?? DEFAULT_MAX_ROUNDS;

    const loop = new AgentLoop({
      llm: this.deps.llm,
      toolRegistry: this.deps.toolRegistry,
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
  }
}

function safeParse(args: string): Record<string, unknown> {
  try {
    return JSON.parse(args) as Record<string, unknown>;
  } catch {
    return {};
  }
}
