import type { ApprovalNarrow, Tool, ToolContext, ToolResult } from './types.js';
import { defaultShellProbe, type ShellProbe } from './shell-routing.js';
import { createShellLauncher, identityWrap, type ShellLauncher } from './shell-launcher.js';

/**
 * powershell — the Windows-native command channel (windows-shell ticket 03),
 * registered only on win32. Semantics mirror the proven Pi tool: pwsh (7+)
 * preferred with Windows PowerShell 5.1 as fallback, hardening flags pinned,
 * and a UTF-8 output preamble so Chinese text never mojibakes.
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const PREVIEW_MAX_CHARS = 200;

/** Force UTF-8 stdout inside the (possibly 5.1) interpreter; never fails. */
export const UTF8_OUTPUT_PREFIX = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {};';

export type PowerShellFlavor = 'pwsh' | 'windowspowershell';

export interface PowerShellShell {
  path: string;
  flavor: PowerShellFlavor;
}

export interface PowerShellInvocation {
  file: string;
  args: string[];
}

/** pwsh.exe first (Core, UTF-8 native), then Windows PowerShell. */
export function resolvePowerShell(probe: ShellProbe): PowerShellShell | null {
  const pwsh = probe.which('pwsh.exe');
  if (pwsh) return { path: pwsh, flavor: 'pwsh' };
  const desktop = probe.which('powershell.exe');
  if (desktop) return { path: desktop, flavor: 'windowspowershell' };
  return null;
}

/**
 * -NoProfile: user profiles must not alter scripted output;
 * -NonInteractive: never wait on a prompt;
 * -ExecutionPolicy Bypass: scripts allowed for this process (admin-enforced
 * policy still wins — documented, not silently worked around).
 */
export function buildPowerShellInvocation(shell: PowerShellShell, command: string): PowerShellInvocation {
  return {
    file: shell.path,
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `${UTF8_OUTPUT_PREFIX}\n${command}`],
  };
}

/** Registration gate: the tool exists on Windows only (Pi parity). */
export function shouldRegisterPowerShell(platform: NodeJS.Platform): boolean {
  return platform === 'win32';
}

export function createPowerShellTool(deps: {
  probe?: ShellProbe;
  /**
   * The single spawn seam (arch ticket 02): run applies the tier-2 OS wrap
   * internally; no wrap knob exists here to forget. Default = identity wrap.
   */
  launcher?: ShellLauncher;
} = {}): Tool {
  const probe = deps.probe ?? defaultShellProbe;
  const launcher = deps.launcher ?? createShellLauncher({ wrap: identityWrap });
  return {
    name: 'powershell',
    display: { kind: 'command' },
    permission: { mode: 'ask', message: 'PowerShell command requires confirmation' },
    metadata: { category: 'shell', cacheable: false, timeout: DEFAULT_TIMEOUT_MS },
    description:
      'Execute a Windows PowerShell command (pwsh 7 when installed, Windows PowerShell otherwise). ' +
      'Use for Windows-native verbs (services, registry, Get-*/Set-* cmdlets); prefer bash for ' +
      'text/build scripting. Runs with -NoProfile -NonInteractive; admin execution policy may still block scripts.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'PowerShell command to execute' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default: 60000)' },
      },
      required: ['command'],
    },
    prepareApproval(params: Record<string, unknown>): ApprovalNarrow {
      const command = typeof params.command === 'string' ? params.command : '';
      if (!command) return {};
      const preview = command.length > PREVIEW_MAX_CHARS ? `${command.slice(0, PREVIEW_MAX_CHARS)}…` : command;
      return { previewNote: `Run (PowerShell): ${preview}` };
    },
    async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const command = params.command as string;
      const timeout = (params.timeout as number) ?? DEFAULT_TIMEOUT_MS;
      const shell = resolvePowerShell(probe);
      if (shell === null) {
        return {
          content: 'No PowerShell executable found (looked for pwsh.exe, then powershell.exe).',
          isError: true,
        };
      }
      const baseInvocation = buildPowerShellInvocation(shell, command);
      const result = await launcher.run(baseInvocation, {
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
