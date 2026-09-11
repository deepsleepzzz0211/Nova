import { spawn } from 'child_process';
import * as os from 'os';
import type { Tool, ToolContext, ToolResult } from './types.js';

const DEFAULT_TIMEOUT_MS = 60_000;

export function createBashTool(): Tool {
  return {
    name: 'bash',
    display: { kind: 'command' },
    description: 'Execute a shell command and return its output.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default: 60000)' },
      },
      required: ['command'],
    },
    requiresPermission: () => true,
    async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const command = params.command as string;
      const timeout = (params.timeout as number) ?? DEFAULT_TIMEOUT_MS;
      const shell = os.platform() === 'win32' ? 'cmd.exe' : 'bash';

      return new Promise<ToolResult>((resolve) => {
        const child = spawn(command, {
          shell,
          cwd: context.workingDirectory,
          signal: context.abortSignal,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
        child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          const killTimer = setTimeout(() => { child.kill('SIGKILL'); }, 5000);
          child.on('close', () => { clearTimeout(killTimer); });
        }, timeout);

        child.on('close', (code) => {
          clearTimeout(timer);
          const output = [stdout, stderr].filter(Boolean).join('');
          resolve({
            content: output,
            metadata: { exitCode: code ?? 1 },
          });
        });

        child.on('error', (err) => {
          clearTimeout(timer);
          resolve({
            content: err.message,
            isError: true,
            metadata: { exitCode: 1 },
          });
        });
      });
    },
  };
}
