/**
 * Non-interactive print mode `nova -p "prompt"` (p1-p2 10, split out of
 * index.tsx): run one turn against the configured provider, stream the
 * answer to stdout, exit. Tool calls run through the normal pipeline;
 * without --yes anything needing permission is denied (no dialog is
 * possible). Used by the E2E suite and scripts.
 */
import { AgentLoop } from '../agent/loop.js';
import type { AppConfig } from '../config/schema.js';
import type { ThinkingLevel } from '../llm/types.js';
import type { ResolvedModel } from '../llm/catalog.js';
import type { LLMProvider } from '../llm/provider.js';
import type { MCPManager } from '../mcp/manager.js';
import type { ToolRuntime } from './tools-runtime.js';
import type { SessionStartup } from './sessions.js';

export async function runPrintMode(opts: {
  printPrompt: string;
  autoApprove: boolean;
  config: AppConfig;
  llm: LLMProvider;
  resolution: ResolvedModel;
  runtime: ToolRuntime;
  session: SessionStartup;
  mcpManager: MCPManager;
}): Promise<never> {
  const { printPrompt, autoApprove, config, llm, resolution, runtime, session, mcpManager } = opts;
  let sawError = false;
  const loop = new AgentLoop({
    llm,
    toolRegistry: runtime.toolRegistry,
    toolExecutionPipeline: runtime.toolExecutionPipeline,
    session: session.sessionStore,
    skills: runtime.skillRegistry,
    promptOptions: {
      environment: runtime.environment,
      projectInstructions: runtime.projectInstructions,
      memory: runtime.memory,
      customPrompt: config.agent.systemPrompt || undefined,
      skillsBudgetTokens: config.agent.skillsBudgetTokens,
    },
    context: {
      maxTokens: resolution.model.contextWindow,
      reserveTokens: config.agent.contextReserveTokens,
      keepRecentTokens: config.agent.contextKeepRecentTokens,
      strategy: config.agent.contextStrategy as 'truncate' | 'compact',
    },
    streamIdleTimeoutMs: config.llm.streamIdleTimeoutMs,
    thinkingLevel: config.agent.thinkingLevel as ThinkingLevel,
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
    // NOTE: byte-identical to the pre-split index.tsx — the original also
    // exits 0 here; the sawError flag above was collected but never used
    // for the exit code. Changing that is a behavior fix, not a refactor.
    process.exit(0);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[error] ${msg}\n`);
    await mcpManager.stopAll();
    process.exit(1);
  }
}
