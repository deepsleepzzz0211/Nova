import { spawn } from 'node:child_process';
import { PACKAGE_NAME } from './constants.js';

export interface SpawnResult {
  code: number;
  output: string;
}

export type SpawnFn = (cmd: string, args: string[]) => Promise<SpawnResult>;

const DEFAULT_SPAWN: SpawnFn = (cmd, args) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, {
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { output += d.toString(); });
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
    child.on('error', (err) => resolve({ code: 1, output: err.message }));
  });

/**
 * Run `npm i -g @posuiqianqiu/nova@latest`.
 * The new version takes effect on next launch — the running process keeps
 * its own bundle.
 */
export async function runNpmUpdate(
  options?: { spawnImpl?: SpawnFn },
): Promise<{ ok: boolean; message: string }> {
  const spawnImpl = options?.spawnImpl ?? DEFAULT_SPAWN;
  try {
    const r = await spawnImpl('npm', ['i', '-g', `${PACKAGE_NAME}@latest`]);
    if (r.code === 0) {
      const tail = r.output.trim().split('\n').slice(-3).join('\n');
      return { ok: true, message: `update installed — restart nova to use it\n${tail}` };
    }
    return { ok: false, message: `update failed:\n${r.output.trim().slice(-400)}` };
  } catch (err: unknown) {
    return { ok: false, message: `update failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
