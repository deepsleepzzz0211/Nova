import { describe, it, expect } from 'vitest';
import {
  makeWorkspace,
  launchTui,
  exitTui,
  cleanup,
} from './harness.js';

/**
 * Deterministic TUI E2E: real PTY, NO LLM calls and NO API key, so it runs in
 * CI on every PR (ubuntu + windows). These cases cover behaviour that needs a
 * real terminal (width handling, command listing) and are the safety net for
 * the terminal-level fixes found during the streaming/TUI work.
 */
describe('TUI deterministic cases (real PTY, no LLM)', () => {
  it('narrow terminal (78 columns) wraps the editor instead of truncating', async () => {
    const cwd = makeWorkspace({ stubKey: true });
    const terminal = await launchTui(cwd, { cols: 100, rows: 30 });
    try {
      await terminal.resize(78, 24);
      await terminal.getByText('Type a message', { regex: true }).expect();

      const head = 'HEAD-marker-';
      const tail = '-TAIL-marker';
      const filler = 'x'.repeat(120 - head.length - tail.length);
      await terminal.type(head + filler + tail);
      await terminal.waitIdle({ timeout: 15_000 }).catch(() => undefined);

      const frame = await terminal.text();
      // Both ends visible => the long line wrapped rather than being cut.
      expect(frame).toContain(head);
      expect(frame).toContain(tail);
      for (const line of frame.split('\n')) {
        expect(line.length).toBeLessThanOrEqual(78);
      }
    } finally {
      await exitTui(terminal).catch(() => terminal.closeQuiet());
      cleanup(cwd);
    }
  });

  it('lists models from the catalog (/model, no LLM request)', async () => {
    const cwd = makeWorkspace({ stubKey: true });
    const terminal = await launchTui(cwd);
    try {
      await terminal.submit('/model');
      // Only the listing prints this header (the footer also names the
      // provider, so asserting the provider alone would be vacuous).
      await terminal.getByText('Provider: e2e', { regex: false }).expect({ timeout: 30_000 });
    } finally {
      await exitTui(terminal).catch(() => terminal.closeQuiet());
      cleanup(cwd);
    }
  });

  it('slash completion opens on "/" and Enter submits the exact command', async () => {
    const cwd = makeWorkspace({ stubKey: true });
    const terminal = await launchTui(cwd);
    try {
      await terminal.type('/comp');
      await terminal.getByText('/compact', { regex: true }).expect();
      // First Enter completes the command (accept), the second submits it:
      // an exact match must not be swallowed by the popup (E2E regression).
      await terminal.keyboard.press('Enter');
      await terminal.getByText('/compact', { regex: true }).expect();
      await terminal.keyboard.press('Enter');
      await terminal.getByText('nothing to compact', { regex: true }).expect({ timeout: 30_000 });
    } finally {
      await exitTui(terminal).catch(() => terminal.closeQuiet());
      cleanup(cwd);
    }
  });
});
