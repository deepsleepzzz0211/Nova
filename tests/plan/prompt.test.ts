import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../../src/agent/prompt.js';
import { gatherEnvironment } from '../../src/agent/environment.js';
import type { Tool } from '../../src/tools/types.js';

function makeTool(name: string, description: string): Tool {
  return {
    name,
    description,
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: 'ok' }),
  };
}

describe('buildSystemPrompt', () => {
  it('includes identity, tools, and skills one-line listings', () => {
    const prompt = buildSystemPrompt(
      [makeTool('read_file', 'Read a file'), makeTool('bash', 'Run a shell command')],
      [{ name: 'deploy', description: 'Deploy the app', path: '/x/SKILL.md' }],
    );
    expect(prompt).toContain('read_file');
    expect(prompt).toContain('Read a file');
    expect(prompt).toContain('**deploy**: Deploy the app');
  });

  it('includes environment info when provided', () => {
    const prompt = buildSystemPrompt([], [], {
      environment: {
        workingDirectory: '/work/project',
        platform: 'win32',
        gitBranch: 'feat/context',
        gitStatus: ' M src/agent/loop.ts',
      },
    });
    expect(prompt).toContain('/work/project');
    expect(prompt).toContain('win32');
    expect(prompt).toContain('feat/context');
    expect(prompt).toContain('M src/agent/loop.ts');
  });

  it('includes project instructions and custom prompt', () => {
    const prompt = buildSystemPrompt([], [], {
      projectInstructions: 'NEVER use any type.',
      customPrompt: 'Be terse.',
    });
    expect(prompt).toContain('NEVER use any type.');
    expect(prompt).toContain('Be terse.');
  });
});

describe('gatherEnvironment', () => {
  it('collects working directory, platform, and git info for a git repo', () => {
    // The project root itself is a git repository
    const env = gatherEnvironment(process.cwd());
    expect(env.workingDirectory).toBe(process.cwd());
    expect(env.platform).toBe(process.platform);
    expect(env.gitBranch).toBeTruthy();
    expect(env.gitStatus).toBeTruthy();
  });

  it('returns undefined git info outside a git repo', () => {
    const env = gatherEnvironment(process.cwd(), { pretendNoGit: true });
    expect(env.gitBranch).toBeUndefined();
    expect(env.gitStatus).toBeUndefined();
  });
});
