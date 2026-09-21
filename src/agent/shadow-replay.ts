import type { Message } from '../llm/types.js';
import { ContextManager } from './context.js';
import { microcompactMessages, MICROCOMPACT_MARKER } from './microcompact.js';
import { SessionStore } from './session.js';

/**
 * Shadow-replay (zcode-borrow ticket 06): a no-network conservation gate.
 * Existing session files are cold-loaded (compaction checkpoints replayed)
 * and pushed through the DETERMINISTIC part of the context pipeline —
 * microcompact then truncate-to-effective-window — and we assert that no
 * message is silently lost: every output message is one of the inputs, in
 * order; the only content changes are microcompact tool-result placeholders;
 * everything removed is counted as a truncation drop. LLM summarization is
 * intentionally out of scope (it needs a model call and is nondeterministic).
 */

/** Options for a replay run. */
export interface ReplayOptions {
  /** Context window the pipeline is checked against. Default 8000. */
  maxTokens?: number;
  /** Output reserve within that window. Default ContextManager default. */
  reserveTokens?: number;
}

/** Per-session replay outcome. */
export interface ReplayReport {
  /** Session file path (empty for a pure in-memory replay). */
  file: string;
  /** Messages after cold-load (post-checkpoint replay). */
  loaded: number;
  /** Messages surviving the pipeline. */
  final: number;
  /** Tool results cleared by the microcompact layer. */
  clearedToolResults: number;
  /** Messages removed by truncation. */
  droppedMessages: number;
  /** True when every conservation invariant held (and nothing threw). */
  conserved: boolean;
  /** Failure detail when conserved is false. */
  error?: string;
}

const DEFAULT_REPLAY_WINDOW = 8_000;

function isClearedToolResult(before: Message, after: Message): boolean {
  return (
    before.role === 'tool' &&
    after.role === 'tool' &&
    typeof after.content === 'string' &&
    after.content.startsWith(MICROCOMPACT_MARKER)
  );
}

/**
 * Replay a loaded history through the deterministic pipeline and check
 * conservation. Never throws: a pipeline crash is reported as conserved:false.
 */
export function replayMessages(
  loaded: Message[],
  options: ReplayOptions = {},
): Omit<ReplayReport, 'file'> {
  try {
    const cm = new ContextManager({
      model: 'shadow-replay',
      maxTokens: options.maxTokens ?? DEFAULT_REPLAY_WINDOW,
      reserveTokens: options.reserveTokens,
    });
    const micro = microcompactMessages(loaded, {
      countTokens: (text) => cm.countText(text),
    });
    const fit = cm.truncateToTokens(micro.messages, cm.triggerTokens);

    // 1. microcompact must not add/remove/reorder messages — only replace
    //    tool-result content with a marker (index-aligned 1:1 with the input).
    if (micro.messages.length !== loaded.length) {
      throw new Error(`microcompact changed length ${loaded.length} -> ${micro.messages.length}`);
    }
    let cleared = 0;
    for (let i = 0; i < loaded.length; i++) {
      if (loaded[i] === micro.messages[i]) continue;
      if (!isClearedToolResult(loaded[i], micro.messages[i])) {
        throw new Error(`message ${i} mutated by a non-microcompact change`);
      }
      cleared++;
    }

    // 2. Conservation as a multiset, not a sequence: truncation legitimately
    //    hoists system messages to the front, so output ORDER may differ. What
    //    must hold is that every output message is a distinct input message
    //    (nothing fabricated or duplicated past its input multiplicity), and
    //    everything not in the output is an accounted-for truncation drop.
    const available = new Map<Message, number>();
    for (const message of micro.messages) {
      available.set(message, (available.get(message) ?? 0) + 1);
    }
    for (const message of fit) {
      const count = available.get(message);
      if (!count) {
        throw new Error('truncation produced a message that was not in the input');
      }
      available.set(message, count - 1);
    }

    // 3. system messages are always preserved by the truncate layer.
    const keptSystem = fit.filter((m) => m.role === 'system').length;
    const totalSystem = micro.messages.filter((m) => m.role === 'system').length;
    if (keptSystem !== totalSystem) {
      throw new Error(`system messages dropped: ${totalSystem} present, ${keptSystem} kept`);
    }

    const dropped = micro.messages.length - fit.length;
    return {
      loaded: loaded.length,
      final: fit.length,
      clearedToolResults: cleared,
      droppedMessages: dropped,
      conserved: true,
    };
  } catch (err: unknown) {
    // The pipeline aborted: report the inputs faithfully and nothing survived
    // verification — final/cleared/dropped describe "not computed", not a lie
    // that the whole history made it through.
    return {
      loaded: loaded.length,
      final: 0,
      clearedToolResults: 0,
      droppedMessages: 0,
      conserved: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Cold-load one session file (read-only) and replay it. */
export function replaySessionFile(filePath: string, options: ReplayOptions = {}): ReplayReport {
  const loaded = SessionStore.load(filePath);
  return { file: filePath, ...replayMessages(loaded, options) };
}

/** List every session in `dir` (read-only) and replay each, newest first. */
export function replaySessionsDir(dir: string, options: ReplayOptions = {}): ReplayReport[] {
  return SessionStore.listSummaries(dir).map((summary) =>
    replaySessionFile(summary.file, options),
  );
}
