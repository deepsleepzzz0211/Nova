/**
 * Non-interactive print mode `nova -p "prompt"` (p1-p2 10, split out of
 * index.tsx; arch2 ticket A3 rewired over the TurnRouter): run one turn
 * against the configured provider, stream the answer, exit. Tool calls run
 * through the normal pipeline; without --yes anything needing permission is
 * denied (no dialog is possible). The turn plumbing (tool pairing, [Error:
 * exit policy, [context] formats) lives in cli/turn-router.ts - this file
 * only picks the output adapter and owns the process boundary (exit codes).
 */
import { errorMessage } from '../shared/errors.js';
import { AgentLoop } from '../agent/loop.js';
import { createJsonlSink } from './jsonl-stream.js';
import {
  createTextSink,
  createTurnRouter,
  formatContextNote,
  type TurnSink,
} from './turn-router.js';
import type { AppConfig } from '../config/schema.js';
import type { ResolvedModel } from '../llm/catalog.js';
import type { LLMProvider } from '../llm/provider.js';
import { loopBaseFromRuntime, type ToolRuntime } from './tools-runtime.js';
import type { SessionStartup } from './sessions.js';

export async function runPrintMode(opts: {
  printPrompt: string;
  autoApprove: boolean;
  config: AppConfig;
  llm: LLMProvider;
  resolution: ResolvedModel;
  runtime: ToolRuntime;
  session: SessionStartup;
  /** stdout format (ticket 08): 'text' keeps today's byte-identical output. */
  outputFormat?: 'text' | 'jsonl';
}): Promise<never> {
  const { printPrompt, autoApprove, config, llm, resolution, runtime, session } = opts;
  const jsonlSink =
    opts.outputFormat === 'jsonl'
      ? createJsonlSink((line) => process.stdout.write(line + '\n'))
      : null;
  jsonlSink?.start(session.sessionStore.sessionId, config.llm.model);
  // Context notices are stderr diagnostics in BOTH formats (stdout stays
  // the requested answer / event stream only).
  const contextNote = (note: string): void => {
    process.stderr.write(formatContextNote(note));
  };
  const sink: TurnSink =
    jsonlSink === null
      ? createTextSink()
      : {
          text: (token) => jsonlSink.text(token),
          toolCall: (call) => jsonlSink.toolCall(call),
          toolResult: (res) => jsonlSink.toolResult(res),
          compaction: (info) => jsonlSink.compaction(info),
          contextNote,
          usage: (usage) => jsonlSink.usage(usage),
          result: (r) => jsonlSink.result(r),
          error: (message) => jsonlSink.error(message),
        };
  const router = createTurnRouter(sink);
  // Shared assembly (arch ticket 04; arch2 ticket A2): one mapper over the
  // runtime bag for TUI + print.
  const base = loopBaseFromRuntime({
    config,
    resolution,
    sessionId: session.sessionStore.sessionId,
    runtime,
  });
  const loop = new AgentLoop({
    llm,
    toolRegistry: runtime.toolRegistry,
    toolExecutionPipeline: runtime.toolExecutionPipeline,
    session: session.sessionStore,
    skills: runtime.skillRegistry,
    directoryInstructions: base.directoryInstructions,
    // Checkpoints still record in print mode — an --resume'd session can
    // /undo its files from the TUI (ticket 03).
    fileHistory: base.fileHistory,
    promptOptions: base.promptOptions,
    context: base.context,
    streamIdleTimeoutMs: base.streamIdleTimeoutMs,
    thinkingLevel: base.thinkingLevel,
    config: base.config,
    ...router.callbacks,
    onPermissionRequest: async () => autoApprove,
  });
  try {
    const result = await loop.processUserInput(printPrompt);
    // arch2 A3 behavior fix: a turn that streamed an [Error: token exits
    // non-zero in BOTH formats (the old text path collected sawError and
    // still exited 0; the pinned e2e was updated with the batch approval).
    const { exitCode } = router.finish({ text: result.text, rounds: result.rounds });
    await runtime.dispose();
    process.exit(exitCode);
  } catch (err: unknown) {
    const { exitCode } = router.fail(errorMessage(err));
    await runtime.dispose();
    process.exit(exitCode);
  }
}
