import { describe, it, expect } from 'vitest';
import { formatWelcomeCard, NOVA_LOGO, type WelcomeInfo } from '../../src/tui/header.js';

// tui-redesign 06: the startup header became an in-transcript welcome card.

function info(overrides: Partial<WelcomeInfo> = {}): WelcomeInfo {
  return {
    version: '9.9.9',
    model: 'Deepseek-v4-flash',
    provider: 'weixin',
    cwd: '/work/proj',
    branch: 'main',
    mcpCount: 0,
    ...overrides,
  };
}

describe('welcome card (tui-redesign 06)', () => {
  it('meta line carries version, provider/model, cwd (branch)', () => {
    const card = formatWelcomeCard(info());
    expect(card.meta).toBe('v9.9.9 · weixin/Deepseek-v4-flash · /work/proj (main)');
  });

  it('appends the MCP count only when connected; degrades without branch/provider', () => {
    expect(formatWelcomeCard(info({ mcpCount: 2 })).meta).toContain('2 MCP');
    const bare = formatWelcomeCard(info({ provider: undefined, branch: null }));
    expect(bare.meta).toBe('v9.9.9 · Deepseek-v4-flash · /work/proj');
  });

  it('ships the block-letter logo and a rotating tip covering the retired hotkey line', () => {
    const t0 = formatWelcomeCard(info(), 0).tip;
    const t1 = formatWelcomeCard(info(), 1).tip;
    expect(t0).not.toBe(t1);
    expect(NOVA_LOGO.length).toBeGreaterThan(3);
    // Between them the tips still document the old hotkeys.
    const all = [0, 1, 2, 3].map((s) => formatWelcomeCard(info(), s).tip).join(' · ');
    for (const k of ['esc', 'ctrl+o', '@', 'shift+enter', 'ctrl+c']) expect(all).toContain(k);
  });

  it('negative seeds still land inside the tip pool', () => {
    const tip = formatWelcomeCard(info(), -3).tip;
    expect(tip.length).toBeGreaterThan(0);
  });
});
