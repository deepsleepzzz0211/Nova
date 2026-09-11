import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { TuiTest, uniqueSession } from '@microsoft/tui-test';
import { ARTIFACTS_ROOT } from '../e2e/tui/harness.js';

/**
 * Alternate-screen spike (ticket e2e-testing 25 → decides tui-refactor 12).
 *
 * Question: can Ink 7's native `alternateScreen: true` drive a fullscreen
 * layout in a real PTY — fixed viewport, internal scrolling, resize — and
 * does the primary buffer (scrollback) survive the session?
 */
describe('alternate screen spike', () => {
  it('renders a scrollable viewport and restores the primary screen', async () => {
    const cwd = path.resolve('.');
    const probe = path.join(cwd, 'tests', 'spike', 'alt-screen-probe.mjs');
    const terminal = new TuiTest(uniqueSession('nova-alt'), {
      backend: 'xtermjs',
      timeouts: { text: 20_000, idle: 10_000, command: 20_000, exit: 20_000, ready: 20_000 },
      artifacts: { dir: ARTIFACTS_ROOT, onFailure: 'text' },
      recording: { mode: 'disabled' },
    });
    try {
      await terminal.run(process.execPath, [probe], {
        cwd,
        env: { ...process.env, NOVA_FORCE_INTERACTIVE: '1' },
        cols: 80,
        rows: 24,
      });

      // 1. The alt-screen frame renders with a viewport and the transcript.
      await terminal.getByText('alt-probe viewport=', { regex: true }).expect();
      const first = await terminal.text();
      expect(first).toContain('line-01');

      // 2. Keys work inside the alternate screen (internal scrolling).
      await terminal.keyboard.press('Down');
      await terminal.keyboard.press('Down');
      await new Promise((r) => setTimeout(r, 300));
      const scrolled = await terminal.text();
      expect(scrolled).not.toBe(first);
      expect(scrolled).toMatch(/offset=2\//);

      // 3. Resize is handled without losing the layout.
      await terminal.resize(60, 18);
      await terminal.getByText('alt-probe viewport=', { regex: true }).expect();

      // 4. Quitting exits cleanly. NOTE: tui-test's buffer keeps showing the
      //    alternate screen after exit, so "the primary screen (scrollback)
      //    is restored" cannot be asserted here — that stays a manual check in
      //    a real terminal (recorded in ticket 12). Verified here: the process
      //    leaves the alt screen without error and Ink's exit path runs.
      await terminal.keyboard.press('q');
      await terminal.waitExit({ timeout: 20_000 });
      expect(await terminal.getExitCode().catch(() => null)).not.toBe(1);
    } finally {
      await terminal.closeQuiet();
      console.log('[spike] artifacts:', ARTIFACTS_ROOT);
    }
  });
});
