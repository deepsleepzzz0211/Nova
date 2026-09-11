import { describe, it, expect } from 'vitest';
import { formatStartupHeader, type StartupHeaderInfo } from '../../src/tui/header.js';

function info(overrides: Partial<StartupHeaderInfo> = {}): StartupHeaderInfo {
  return {
    version: '9.9.9',
    model: 'Deepseek-v4-flash',
    provider: 'weixin',
    thinkingLevel: 'off',
    contextFiles: [],
    skillNames: [],
    mcpServers: [],
    cwd: '/work/proj',
    ...overrides,
  };
}

describe('startup header (tui-refactor 10)', () => {
  it('leads with version, provider/model, thinking level and the hotkeys', () => {
    const lines = formatStartupHeader(info()).split('\n');
    expect(lines[0]).toBe('nova 9.9.9 · weixin/Deepseek-v4-flash · thinking off');
    expect(lines[1]).toContain('esc interrupt');
    expect(lines[1]).toContain('ctrl+o tools');
    expect(lines[1]).toContain('@ file completion');
    expect(lines[2]).toContain('/work/proj');
  });

  it('lists only the sections that were actually loaded', () => {
    const minimal = formatStartupHeader(info());
    expect(minimal).not.toContain('context:');
    expect(minimal).not.toContain('skills');
    expect(minimal).not.toContain('mcp:');

    const full = formatStartupHeader(
      info({
        contextFiles: ['AGENTS.md', 'MEMORY.md'],
        skillNames: ['alpha', 'beta'],
        mcpServers: ['files'],
      }),
    );
    expect(full).toContain('context: AGENTS.md, MEMORY.md');
    expect(full).toContain('skills (2): alpha, beta');
    expect(full).toContain('mcp: files');
  });

  it('omits the provider prefix and thinking level when unknown', () => {
    const line = formatStartupHeader(
      info({ provider: undefined, thinkingLevel: undefined }),
    ).split('\n')[0];
    expect(line).toBe('nova 9.9.9 · Deepseek-v4-flash');
  });
});
