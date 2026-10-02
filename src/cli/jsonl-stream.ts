/**
 * NDJSON event sink for `nova -p --output-format jsonl` (batch-B ticket 08):
 * one JSON object per line on stdout, schema version v:1. Event family:
 * start / text / tool_call / tool_result / compaction / usage / result /
 * error. Any single event larger than MAX_EVENT_BYTES is content-truncated
 * and flagged truncated:true (the [PARTIAL] discipline from the pipeline).
 * The writer owns line assembly; the caller owns newline placement.
 */

export const MAX_EVENT_BYTES = 65_536;

export interface JsonlSink {
  start(sessionId: string, model: string): void;
  text(delta: string): void;
  toolCall(call: { id: string; name: string; arguments: string }): void;
  toolResult(res: { id?: string; name: string; content: string; isError: boolean }): void;
  compaction(info: { strategy: string; reason: string; beforeTokens: number; afterTokens: number }): void;
  usage(u: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; cacheWriteTokens?: number }): void;
  result(r: { text: string; rounds: number; exitCode: number }): void;
  error(message: string): void;
}

const TRUNCATION_ELLIPSIS = '…';

/** Shrink margin for the ellipsis + truncated flag themselves. */
const TRUNCATION_HEADROOM_CHARS = 64;
/** Extra characters dropped per shrink pass (UTF-8 bytes != chars). */
const CHARS_PER_SHRINK_PASS = 512;
/** Shrink is bounded so a pathological payload still terminates. */
const MAX_SHRINK_PASSES = 8;

export function createJsonlSink(writeLine: (line: string) => void): JsonlSink {
  /** Serialize with a hard byte cap on the payload-bearing field. */
  const emit = (obj: Record<string, unknown>, capField?: string): void => {
    let line = JSON.stringify(obj);
    if (capField !== undefined && Buffer.byteLength(line, 'utf8') > MAX_EVENT_BYTES) {
      const full = String(obj[capField] ?? '');
      let keep = Math.max(0, full.length - (Buffer.byteLength(line, 'utf8') - MAX_EVENT_BYTES) - TRUNCATION_HEADROOM_CHARS);
      for (let i = 0; i < MAX_SHRINK_PASSES && Buffer.byteLength(line, 'utf8') > MAX_EVENT_BYTES; i++) {
        line = JSON.stringify({
          ...obj,
          [capField]: full.slice(0, keep) + TRUNCATION_ELLIPSIS,
          truncated: true,
        });
        keep = Math.max(0, keep - CHARS_PER_SHRINK_PASS);
      }
    }
    writeLine(line);
  };

  return {
    start(sessionId, model) {
      emit({ v: 1, ev: 'start', session_id: sessionId, model });
    },
    text(delta) {
      emit({ v: 1, ev: 'text', delta }, 'delta');
    },
    toolCall(call) {
      emit({ v: 1, ev: 'tool_call', id: call.id, name: call.name, arguments: call.arguments }, 'arguments');
    },
    toolResult(res) {
      emit(
        {
          v: 1,
          ev: 'tool_result',
          ...(res.id !== undefined ? { id: res.id } : {}),
          name: res.name,
          content: res.content,
          is_error: res.isError,
        },
        'content',
      );
    },
    compaction(info) {
      emit({
        v: 1,
        ev: 'compaction',
        strategy: info.strategy,
        reason: info.reason,
        before_tokens: info.beforeTokens,
        after_tokens: info.afterTokens,
      });
    },
    usage(u) {
      emit({
        v: 1,
        ev: 'usage',
        input_tokens: u.inputTokens,
        output_tokens: u.outputTokens,
        cached_tokens: u.cachedInputTokens ?? 0,
        cache_write_tokens: u.cacheWriteTokens ?? 0,
      });
    },
    result(r) {
      emit({ v: 1, ev: 'result', text: r.text, rounds: r.rounds, exit_code: r.exitCode }, 'text');
    },
    error(message) {
      emit({ v: 1, ev: 'error', message }, 'message');
    },
  };
}
