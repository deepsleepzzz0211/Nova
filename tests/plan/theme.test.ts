import { describe, it, expect } from 'vitest';
import { theme } from '../../src/tui/theme.js';
import { workingBorderColor } from '../../src/tui/status-format.js';

describe('theme tokens (tui-refactor 11)', () => {
  it('covers the semantic roles components rely on', () => {
    for (const key of [
      'primary',
      'secondary',
      'border',
      'success',
      'error',
      'warning',
      'muted',
      'userMessage',
      'toolTitle',
      'toolOutput',
      'diffAdded',
      'diffRemoved',
      'diffContext',
      'mdHeading',
      'mdCode',
      'mdListBullet',
    ] as const) {
      expect(theme[key]).toBeTruthy();
    }
    expect(theme.working.idle).toBeTruthy();
    expect(theme.working.streaming).not.toBe(theme.working.idle);
    expect(theme.working.thinking).not.toBe(theme.working.streaming);
    expect(theme.syntax.keyword).toBeTruthy();
  });

  it('drives the working indicator colours from the same palette', () => {
    expect(workingBorderColor('idle')).toBe(theme.working.idle);
    expect(workingBorderColor('streaming')).toBe(theme.working.streaming);
    expect(workingBorderColor('thinking')).toBe(theme.working.thinking);
  });

  // tui-redesign 01: the palette is real hex tokens (ZCode-style), not ANSI
  // colour names — terminals render truecolor, and the same tokens will back
  // background bands (user messages, diffs) later in the redesign.
  it('every token value is a 6-digit hex colour', () => {
    const flat: string[] = [];
    for (const value of Object.values(theme)) {
      if (typeof value === 'string') flat.push(value);
      else if (value && typeof value === 'object') flat.push(...Object.values(value));
    }
    expect(flat.length).toBeGreaterThan(20);
    for (const v of flat) expect(v).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('exposes surface/band tokens for background-coloured elements', () => {
    for (const key of [
      'bg',
      'panel',
      'element',
      'userBand',
      'borderActive',
      'borderSubtle',
      'text',
      'diffAddedBg',
      'diffRemovedBg',
    ] as const) {
      expect(theme[key]).toBeTruthy();
    }
    // Surfaces must be distinguishable (band brighter than panel, etc.).
    expect(theme.userBand).not.toBe(theme.panel);
    expect(theme.panel).not.toBe(theme.bg);
    expect(theme.element).not.toBe(theme.panel);
    // No ANSI colour names left anywhere in the palette.
    const ansi = new Set(['cyan', 'magenta', 'gray', 'grey', 'red', 'green', 'yellow', 'blue', 'white', 'black']);
    const values = Object.values(theme).flatMap((v) => (typeof v === 'string' ? [v] : []));
    expect(values.filter((v) => ansi.has(v))).toEqual([]);
  });

  it('maps semantic roles onto the new palette coherently', () => {
    expect(theme.primary).toBe('#7dd3fc'); // accent
    expect(theme.secondary).toBe('#c4b5fd'); // violet
    expect(theme.success).toBe('#86efac');
    expect(theme.warning).toBe('#fbbf24');
    expect(theme.error).toBe('#fca5a5');
    expect(theme.muted).toBe('#94a3b8');
    expect(theme.diffAddedBg).toBe('#12351e');
    expect(theme.diffRemovedBg).toBe('#3b1d17');
  });
});
