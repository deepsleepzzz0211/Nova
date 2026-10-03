import type { ApprovalNarrow, Tool, ToolContext, ToolResult } from './types.js';
import { buildSpawnInvocation, resolveShellFromProcess, type ShellPlan } from './shell-routing.js';
import { createShellLauncher, identityWrap, type ShellLauncher } from './shell-launcher.js';
import { JOB_KILL_TOOL_NAME, JOB_OUTPUT_TOOL_NAME, type JobHandle, type JobRegistry } from './jobs.js';
import type { ShellSessionRegistry } from './shell-session.js';

const DEFAULT_TIMEOUT_MS = 60_000;

/** Cap the echoed command in the approval preview. */
const PREVIEW_MAX_CHARS = 200;

let fallbackWarned = false;

/** Warn once per process when the cmd.exe fallback kicks in (stderr only). */
function announceFallbackOnce(plan: ShellPlan): void {
  if (plan.fallbackNotice === undefined || fallbackWarned) return;
  fallbackWarned = true;
  console.error(`[nova] bash tool: ${plan.fallbackNotice}`);
}

/**
 * `resolvePlan` is injectable for tests and for the powershell tool's shared
 * spawn plumbing; production resolves the real environment (windows-shell 01).
 */
export function createBashTool(deps: {
  resolvePlan?: () => ShellPlan;
  jobs?: JobRegistry;
  sessions?: ShellSessionRegistry;
  /**
   * The single spawn seam (arch ticket 02): run/start apply the tier-2 OS
   * wrap internally — this tool has no wrap knob to forget. Default is an
   * unwrapping launcher (identity wrap) for tests and os_level=off runs.
   */
  launcher?: ShellLauncher;
} = {}): Tool {
  const resolvePlan = deps.resolvePlan ?? resolveShellFromProcess;
  const launcher = deps.launcher ?? createShellLauncher({ wrap: identityWrap });
  return {
    name: 'bash',
    display: { kind: 'command' },
    description:
      'Execute a shell command and return its output. On Windows commands run in a POSIX ' +
      'bash (Git Bash) when available; otherwise cmd.exe — check the Platform/Shell lines ' +
      'in the environment section before using bash-specific syntax.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default: 60000)' },
        background: { type: 'boolean', description: `Run without waiting: returns a job id immediately; read output with ${JOB_OUTPUT_TOOL_NAME} and stop with ${JOB_KILL_TOOL_NAME}` },
        session: { type: 'string', description: 'Named persistent shell: same name reuses one bash process, keeping cwd/env/functions across calls. Commands must not read stdin.' },
        session_reset: { type: 'boolean', description: 'With session: drop that shell first and start from a clean one' },
      },
      required: ['command'],
    },
    permission: { mode: 'ask', message: 'Bash command requires confirmation' },
    // Preview-only approval hook (ticket 08): echoes the exact command so the
    // user sees what will run. Narrow-only — it never approves on their behalf.
    prepareApproval(params: Record<string, unknown>): ApprovalNarrow {
      const command = typeof params.command === 'string' ? params.command : '';
      if (!command) return {};
      const preview =
        command.length > PREVIEW_MAX_CHARS
          ? `${command.slice(0, PREVIEW_MAX_CHARS)}…`
          : command;
      return { previewNote: `Run: ${preview}` };
    },
    async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const command = params.command as string;
      const timeout = (params.timeout as number) ?? DEFAULT_TIMEOUT_MS;

      let plan: ShellPlan;
      try {
        plan = resolvePlan();
      } catch (err) {
        return { content: `Shell resolution failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
      announceFallbackOnce(plan);
      const sessionName =
        typeof params.session === 'string' && params.session.trim() !== ''
          ? params.session.trim()
          : undefined;
      if (sessionName !== undefined) {
        if (deps.sessions === undefined) {
          return { content: 'Persistent shell sessions are not available in this session.', isError: true };
        }
        if (plan.kind !== 'bash') {
          return {
            content: 'Persistent shell sessions require a bash-family shell; the resolved shell is not bash.',
            isError: true,
          };
        }
        if (params.session_reset === true) deps.sessions.reset(sessionName);
        const res = await deps.sessions.run(sessionName, command, context.workingDirectory, timeout);
        // exit -1 is the registry's transport-failure sentinel (death/timeout),
        // never a real $? (bash reports 255 for exit -1).
        return {
          content:
            (res.restarted ? '[session restarted]\n' : '') +
            res.out +
            (res.exitCode > 0 ? `\n[exit ${res.exitCode}]` : ''),
          ...(res.exitCode === -1 ? { isError: true } : {}),
          metadata: { exitCode: res.exitCode },
        };
      }

      const invocation = buildSpawnInvocation(plan, command);

      if (params.background === true) {
        if (deps.jobs === undefined) {
          return { content: 'Background jobs are not available in this session.', isError: true };
        }
        // Refuse BEFORE spawning: a capped request must never leave an
        // untracked live process behind the refusal message.
        const refusal = deps.jobs.capacityRefusal();
        if (refusal !== undefined) {
          return { content: refusal, isError: true };
        }
        let handle: JobHandle;
        try {
          handle = launcher.start(invocation, { cwd: context.workingDirectory });
        } catch (err) {
          return {
            content: `Background spawn failed: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
        const started = deps.jobs.start(command, handle);
        if (!started.started) {
          // Unreachable after the precheck (no await gap), but if the cap
          // logic ever diverges: never leave the spawned handle orphaned.
          handle.kill('SIGTERM');
          return { content: started.reason, isError: true };
        }
        const preview =
          command.length > PREVIEW_MAX_CHARS
            ? `${command.slice(0, PREVIEW_MAX_CHARS)}…`
            : command;
        return {
          content:
            `Started background job ${started.jobId} (pid ${started.pid ?? 'unknown'}): ${preview}\n` +
            `The command is still running. Read incremental output with ${JOB_OUTPUT_TOOL_NAME} {jobId, cursor} ` +
            `and terminate it with ${JOB_KILL_TOOL_NAME}.`,
        };
      }

      const result = await launcher.run(invocation, {
        cwd: context.workingDirectory,
        signal: context.abortSignal,
        timeoutMs: timeout,
      });
      return {
        content: result.content,
        ...(result.isError !== undefined ? { isError: true } : {}),
        metadata: { exitCode: result.exitCode },
      };
    },
  };
}
