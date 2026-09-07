import { describe, it, expect } from 'vitest';
import { runNpmUpdate } from '../../src/update/run-update.js';

describe('runNpmUpdate', () => {
  it('runs npm i -g with the scoped package on the injected spawner', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const result = await runNpmUpdate({
      spawnImpl: async (cmd, args) => {
        calls.push({ cmd, args });
        return { code: 0, output: 'added 1 package in 3s' };
      },
    });

    expect(calls[0].cmd).toBe('npm');
    expect(calls[0].args).toEqual(['i', '-g', '@posuiqianqiu/nova@latest']);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('restart');
  });

  it('reports failure with the error output', async () => {
    const result = await runNpmUpdate({
      spawnImpl: async () => ({ code: 1, output: 'npm error E403 forbidden' }),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('E403');
  });

  it('survives a throwing spawner', async () => {
    const result = await runNpmUpdate({
      spawnImpl: async () => { throw new Error('spawn ENOENT'); },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('spawn ENOENT');
  });
});
