import type {
  PipelineHooks,
  PreToolUseHook,
  PostToolUseHook,
  PostToolUseObservation,
} from './types.js';
import type { ToolResult } from '../shared/tool-contracts.js';

/**
 * Declarative hooks (batch-B ticket 03, gap G9): config.toml entries become
 * shell commands run around matching tool calls through the existing
 * PipelineHooks seam. The JSON payload travels on stdin (Claude Code
 * convention); a pre hook denies via exit code 2 or a `{"deny":true}` stdout;
 * a post hook's stdout is surfaced as a note.
 */

/** One [[hooks.*]] entry from config (already normalized). */
export interface HookSpec {
  event: 'pre_tool_use' | 'post_tool_use';
  /** Exact tool name, or '*' to match every tool. */
  matcher: string;
  /** Shell command line; receives the event JSON on stdin. */
  command: string;
  timeoutMs?: number;
}

export interface HookRequest {
  command: string;
  inputJson: string;
  timeoutMs: number;
}

export interface SpawnedHook {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/** Injectable spawn seam (unit tests never spawn; production uses the default). */
export type SpawnHook = (req: HookRequest) => Promise<SpawnedHook>;

/** Post-hook observation returned to the pipeline; `note` is appended to the tool result. */
export type { PostToolUseObservation } from './types.js';

/** Default hook timeout (a hung hook must not stall the turn). */
export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;

function matches(matcher: string, tool: string): boolean {
  return matcher === '*' || matcher === tool;
}

interface PreInput {
  tool: string;
  params: Record<string, unknown>;
}

async function runPreHook(spec: HookSpec, input: PreInput, spawn: SpawnHook) {
  if (!matches(spec.matcher, input.tool)) return undefined;
  const res = await spawn({
    command: spec.command,
    inputJson: JSON.stringify({ hook_event_name: 'pre_tool_use', ...input }),
    timeoutMs: spec.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
  });
  if (res.timedOut === true) {
    // A gate that cannot answer is NOT a pass: fail closed, visibly.
    return { deny: true, reason: `pre-tool-use hook "${spec.command}" timed out — denied under the sandbox gate` };
  }
  // Deny is a DUAL channel (ticket 03): exit 2 OR {"deny":true} on stdout.
  // The structured verdict wins at any exit code — a hook that printed it
  // but crashed afterwards still asked to deny, and pass-through would
  // silently widen the sandbox.
  const stdout = res.stdout.trim();
  if (stdout !== '') {
    try {
      const parsed = JSON.parse(stdout) as { deny?: unknown; reason?: unknown };
      if (parsed.deny === true) {
        return { deny: true, reason: typeof parsed.reason === 'string' ? parsed.reason : `blocked by hook "${spec.command}"` };
      }
    } catch {
      // Non-JSON stdout is chatter; the exit codes below decide.
    }
  }
  if (res.code === 2) {
    return { deny: true, reason: (res.stderr.trim() || `blocked by hook "${spec.command}"`) };
  }
  if (res.code !== 0) {
    // Pass-through, but not silent: stderr for logs AND a note that the
    // pipeline carries into the tool result (ticket 03 transcript promise).
    console.error(`[hook] pre "${spec.command}" failed (exit ${res.code}) — passing through: ${res.stderr.trim()}`);
    return { note: `hook pre "${spec.command}" failed (exit ${res.code}): ${res.stderr.trim()}` };
  }
  return undefined;
}

async function runPostHook(
  spec: HookSpec,
  input: { tool: string; params: Record<string, unknown>; result: ToolResult },
  spawn: SpawnHook,
): Promise<PostToolUseObservation | undefined> {
  if (!matches(spec.matcher, input.tool)) return undefined;
  const res = await spawn({
    command: spec.command,
    inputJson: JSON.stringify({ hook_event_name: 'post_tool_use', ...input }),
    timeoutMs: spec.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
  });
  if (res.timedOut === true || res.code !== 0) {
    const what = res.timedOut ? 'timed out' : `failed (exit ${res.code})`;
    console.error(`[hook] post "${spec.command}" ${what} — result stands, note surfaces in transcript`);
    return { note: `hook post "${spec.command}" ${what}${res.stderr.trim() === '' ? '' : `: ${res.stderr.trim()}`}` };
  }
  const note = res.stdout.trim();
  return note === '' ? undefined : { note };
}

/**
 * Translate config hook specs into PipelineHooks. The spawn seam is
 * injected by the caller (the CLI owns shell resolution; this module stays
 * free of tool-layer imports so the module graph keeps hooks → shared only).
 */
export function buildPipelineHooks(
  specs: readonly HookSpec[],
  spawn: SpawnHook,
): PipelineHooks {
  const pre: PreToolUseHook[] = specs
    .filter((s) => s.event === 'pre_tool_use')
    .map((spec) => async (input) => runPreHook(spec, input, spawn));
  const post: PostToolUseHook[] = specs
    .filter((s) => s.event === 'post_tool_use')
    .map((spec) => async (input) => runPostHook(spec, input, spawn));
  return {
    ...(pre.length > 0 ? { pre } : {}),
    ...(post.length > 0 ? { post } : {}),
  };
}
