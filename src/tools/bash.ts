import type { ApprovalNarrow, Tool, ToolContext, ToolResult } from './types.js';
import { buildSpawnInvocation, resolveShellFromProcess, type ShellPlan } from './shell-routing.js';
import { runSpawnCommand } from './spawn-runner.js';

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
export function createBashTool(deps: { resolvePlan?: () => ShellPlan } = {}): Tool {
  const resolvePlan = deps.resolvePlan ?? resolveShellFromProcess;
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
      const invocation = buildSpawnInvocation(plan, command);

      const result = await runSpawnCommand(invocation, {
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
