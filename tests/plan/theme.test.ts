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
});
