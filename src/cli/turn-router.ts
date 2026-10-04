import type { AgentLoopConfig, ContextDecisionReason } from '../agent/loop-types.js';
import type { TurnUsage } from '../cache/prompt-cache-metrics.js';
import type { ToolResult } from '../tools/types.js';

/**
 * TurnSink (arch2 ticket A3): everything a turn produces, as data. print
 * mode used to re-implement the plumbing per output format - id->name tool
 * pairing, the [Error: token that decides the exit code, the [context]
 * line formats - and the copies drifted (the text adapter collected
 * sawError but still exited 0; jsonl got it right). The router owns the
 * plumbing ONE time; adapters only decide where the events render. A third
 * adapter (the TUI) can adopt the same seam when its React plumbing is
 * reshaped; that is deliberately not forced here.
 */
export interface TurnSink {
  text(token: string): void;
  toolCall(call: { id: string; name: string; arguments: string }): void;
  toolResult(res: { id?: string; name: string; content: string; isError: boolean }): void;
  compaction(info: {
    strategy: 'truncate' | 'compact' | 'microcompact';
    reason: ContextDecisionReason;
    beforeTokens: number;
    afterTokens: number;
  }): void;
  contextNote(note: string): void;
  usage(usage: TurnUsage): void;
  /** Turn ended normally; exitCode is the router's policy decision. */
  result(r: { text: string; rounds: number; exitCode: number }): void;
  /** Turn threw (or is otherwise being reported as failed). */
  error(message: string): void;
}

export interface TurnRouter {
  /** Spread straight into the AgentLoop config; owns all pairing state. */
  callbacks: Pick<
    AgentLoopConfig,
    'onToken' | 'onToolCall' | 'onToolCallReady' | 'onToolResult' | 'onThinking' | 'onCompaction' | 'onUsage' | 'onContextNote'
  >;
  /** Normal end of a processed turn: computes and reports the exit code. */
  finish(result: { text: string; rounds: number }): { exitCode: number };
  /** Thrown turn: routes the message and exits 1. */
  fail(message: string): { exitCode: number };
}

/** Tokens start with this prefix when the loop reports a failure (see loop.ts). */
const ERROR_TOKEN_PREFIX = '[Error:';

export function formatContextNote(note: string): string {
  return `[context] ${note}\n`;
}

export function formatCompactionLine(info: {
  strategy: string;
  reason: string;
  beforeTokens: number;
  afterTokens: number;
}): string {
  return `[context] ${info.strategy} (${info.reason}): ${info.beforeTokens} -> ${info.afterTokens} tokens\n`;
}

export function createTurnRouter(sink: TurnSink): TurnRouter {
  const callNames = new Map<string, string>();
  let sawError = false;
  return {
    callbacks: {
      onToken: (token: string) => {
        if (token.startsWith(ERROR_TOKEN_PREFIX)) sawError = true;
        sink.text(token);
      },
      // The mid-stream call event carries empty arguments (streaming ticket
      // 04); the complete record arrives via onToolCallReady.
      onToolCall: () => {},
      onToolCallReady: (call) => {
        callNames.set(call.id, call.function.name);
        sink.toolCall({ id: call.id, name: call.function.name, arguments: call.function.arguments });
      },
      onToolResult: (result: ToolResult, callId?: string) => {
        sink.toolResult({
          ...(callId !== undefined ? { id: callId } : {}),
          name: callId !== undefined ? callNames.get(callId) ?? 'tool' : 'tool',
          content: result.content,
          isError: result.isError === true,
        });
      },
      onThinking: () => {},
      onCompaction: (info) => {
        sink.compaction({
          strategy: info.strategy,
          reason: info.reason,
          beforeTokens: info.beforeTokens,
          afterTokens: info.afterTokens,
        });
      },
      onUsage: (usage) => sink.usage(usage),
      onContextNote: (note) => sink.contextNote(note),
    },
    finish: (result) => {
      const exitCode = sawError ? 1 : 0;
      sink.result({ text: result.text, rounds: result.rounds, exitCode });
      return { exitCode };
    },
    fail: (message) => {
      sink.error(message);
      return { exitCode: 1 };
    },
  };
}

/** Human stdout/stderr adapter - the shape print mode always had. */
export function createTextSink(deps: {
  out?: (chunk: string) => void;
  err?: (chunk: string) => void;
} = {}): TurnSink {
  const out = deps.out ?? ((chunk: string) => process.stdout.write(chunk));
  const err = deps.err ?? ((chunk: string) => process.stderr.write(chunk));
  return {
    text: (token) => out(token),
    // Text mode answers with prose only; tool traffic ran invisibly before
    // the split and stays invisible (permission checks still apply).
    toolCall: () => {},
    toolResult: () => {},
    compaction: (info) => err(formatCompactionLine(info)),
    contextNote: (note) => err(formatContextNote(note)),
    usage: () => {},
    result: (r) => {
      if (r.text.length > 0 && !r.text.endsWith('\n')) out('\n');
    },
    error: (message) => err(`[error] ${message}\n`),
  };
}
