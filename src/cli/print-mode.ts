/**
 * Non-interactive print mode `nova -p "prompt"` (p1-p2 10, split out of
 * index.tsx): run one turn against the configured provider, stream the
 * answer to stdout, exit. Tool calls run through the normal pipeline;
 * without --yes anything needing permission is denied (no dialog is
 * possible). Used by the E2E suite and scripts.
 */
import { AgentLoop } from '../agent/loop.js';
import { createJsonlSink } from './jsonl-stream.js';
import { DirectoryInstructions } from '../agent/directory-instructions.js';
import { FileHistory, fileHistoryDir } from '../agent/file-history.js';
import { novaHome } from '../config/loader.js';
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
  /** stdout format (ticket 08): 'text' keeps today's byte-identical output. */
  outputFormat?: 'text' | 'jsonl';
}): Promise<never> {
  const { printPrompt, autoApprove, config, llm, resolution, runtime, session, mcpManager } = opts;
  const sink =
    opts.outputFormat === 'jsonl'
      ? createJsonlSink((line) => process.stdout.write(line + String.fromCharCode(10)))
      : null;
  sink?.start(session.sessionStore.sessionId, config.llm.model);
  // tool_call ids -> names so tool_result events can carry the name.
  const callNames = new Map<string, string>();
  let sawError = false;
  const loop = new AgentLoop({
    llm,
    toolRegistry: runtime.toolRegistry,
    toolExecutionPipeline: runtime.toolExecutionPipeline,
    session: session.sessionStore,
    skills: runtime.skillRegistry,
    directoryInstructions: new DirectoryInstructions({
      rootDir: runtime.environment?.workingDirectory ?? process.cwd(),
    }),
    // Checkpoints still record in print mode — an --resume'd session can
    // /undo its files from the TUI (ticket 03).
    fileHistory: new FileHistory({
      historyDir: fileHistoryDir(novaHome(), session.sessionStore.sessionId),
    }),
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
      if (sink !== null) sink.text(token);
      else process.stdout.write(token);
    },
    onToolCall: sink === null ? () => {} : (call) => {
      callNames.set(call.id, call.function.name);
    },
    onToolCallReady: sink === null ? undefined : (call) => {
      callNames.set(call.id, call.function.name);
      sink.toolCall({ id: call.id, name: call.function.name, arguments: call.function.arguments });
    },
    onToolResult: sink === null ? () => {} : (result, callId) => {
      sink.toolResult({
        ...(callId !== undefined ? { id: callId } : {}),
        name: callId !== undefined ? callNames.get(callId) ?? 'tool' : 'tool',
        content: result.content,
        isError: result.isError === true,
      });
    },
    onThinking: () => {},
    // Context-policy observability: diagnostics go to stderr, never stdout
    // (stdout stays the requested answer only).
    onCompaction: (info) => {
      if (sink !== null) {
        sink.compaction({
          strategy: info.strategy,
          reason: info.reason,
          beforeTokens: info.beforeTokens,
          afterTokens: info.afterTokens,
        });
        return;
      }
      process.stderr.write(`[context] ${info.strategy} (${info.reason}): ${info.beforeTokens} -> ${info.afterTokens} tokens\n`);
    },
    onUsage: sink === null ? undefined : (usage) => sink.usage(usage),
    onContextNote: (note) => {
      process.stderr.write(`[context] ${note}\n`);
    },
    onPermissionRequest: async () => autoApprove,
  });
  try {
    const result = await loop.processUserInput(printPrompt);
    if (sink !== null) {
      sink.result({ text: result.text, rounds: result.rounds, exitCode: sawError ? 1 : 0 });
      await mcpManager.stopAll();
      // jsonl pays the old NOTE debt: sawError really exits non-zero here.
      // The text branch below keeps its historical exit-0 behavior.
      process.exit(sawError ? 1 : 0);
    }
    if (result.text.length > 0 && !result.text.endsWith('\n')) process.stdout.write('\n');
    await mcpManager.stopAll();
    // NOTE: byte-identical to the pre-split index.tsx — the original also
    // exits 0 here; the sawError flag above was collected but never used
    // for the exit code. Changing that is a behavior fix, not a refactor.
    process.exit(0);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (sink !== null) sink.error(msg);
    else process.stderr.write(`[error] ${msg}\n`);
    await mcpManager.stopAll();
    process.exit(1);
  }
}
