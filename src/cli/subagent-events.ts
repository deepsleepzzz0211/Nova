/**
 * Subagent event → UI sink rendering (shell-snapshot ratchet follow-up).
 * Moved out of the composition root so tools-runtime.ts assembles the
 * spawner without owning its presentation mapping. Token events are
 * deliberately not surfaced here: they are high-volume and would flood the
 * transcript; the sink API still receives them for future richer UI.
 */
import type { SubagentEvent } from '../subagent/spawner.js';

/** UI sinks the TUI attaches to after mount (useAgent assigns notify/set). */
export interface SubagentSinks {
  notify?: (message: string) => void;
  set?: (line: string | null) => void;
}

/** Longest task preview shown in a start line before ellipsis. */
const TASK_PREVIEW_CHARS = 80;

/** The `notify` slot of a sinks pair, shaped for the runtime bag. */
export type SubagentNotifySink = Pick<SubagentSinks, 'notify'>;

/** The `set` slot of a sinks pair, shaped for the runtime bag. */
export type SubagentLiveSink = Pick<SubagentSinks, 'set'>;

/** Render one spawner event into the two sinks. */
export function renderSubagentEvent(sinks: SubagentSinks, event: SubagentEvent): void {
  const who = event.agentName ?? event.agentId;
  if (event.type === 'start') {
    const task = typeof event.payload === 'string' ? event.payload.slice(0, TASK_PREVIEW_CHARS) : '';
    sinks.notify?.(`[subagent ${who} started] ${task}`);
  } else if (event.type === 'end') {
    sinks.set?.(null);
    sinks.notify?.(`[subagent ${event.agentId} finished: ${event.rounds} rounds]`);
  } else if (event.type === 'tool_call') {
    const tool = (event.payload as { function?: { name?: string } } | undefined)?.function?.name ?? 'tool';
    sinks.notify?.(`[subagent ${event.agentId}] ▸ ${tool}`);
    sinks.set?.(`${who} ▸ ${tool}`);
  } else if (event.type === 'tool_result') {
    const failed = (event.payload as { isError?: boolean } | undefined)?.isError === true;
    sinks.notify?.(`[subagent ${event.agentId}] ${failed ? '✗ tool error' : '✓ tool done'}`);
    sinks.set?.(`${event.agentId} ${failed ? '✗ error' : '✓ done'}`);
  }
}
