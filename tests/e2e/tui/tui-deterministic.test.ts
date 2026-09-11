import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  makeWorkspace,
  launchTui,
  exitTui,
  announceArtifacts,
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
      announceArtifacts();
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
      announceArtifacts();
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
      announceArtifacts();
      cleanup(cwd);
    }
  });

  it('--resume loads a previous session from disk and shows it', async () => {
    // Deterministic: the session file is written by hand, so no LLM is needed.
    // NOVA_HOME/sessions is where the store appends one JSON object per line.
    const cwd = makeWorkspace({ stubKey: true });
    const sessionsDir = path.join(cwd, '.nova', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, 'session-2020-01-01T00-00-00-000Z.jsonl'),
      [
        JSON.stringify({ role: 'user', content: 'RESUMED-USER-MARKER' }),
        JSON.stringify({ role: 'assistant', content: 'RESUMED-ASSIST-MARKER' }),
        '',
      ].join('\n'),
      'utf-8',
    );

    const terminal = await launchTui(cwd, { args: ['--resume'] });
    try {
      // Both restored turns must be rendered from the persisted history.
      await terminal.getByText('RESUMED-USER-MARKER', { regex: false }).expect({ timeout: 30_000 });
      await terminal.getByText('RESUMED-ASSIST-MARKER', { regex: false }).expect({ timeout: 30_000 });
    } finally {
      await exitTui(terminal).catch(() => terminal.closeQuiet());
      announceArtifacts();
      cleanup(cwd);
    }
  });

  it('/compact reports the no-op exactly once per invocation', async () => {
    // Regression guard for the duplicated-notice bug: the loop announces a
    // successful compaction itself, so the command must not add a second line.
    const cwd = makeWorkspace({ stubKey: true });
    const terminal = await launchTui(cwd);
    try {
      await terminal.submit('/compact');
      await terminal.getByText('nothing to compact', { regex: true }).expect({ timeout: 30_000 });
      await terminal.waitIdle({ timeout: 10_000 }).catch(() => undefined);
      const frame = await terminal.text();
      const occurrences = frame.split('nothing to compact').length - 1;
      expect(occurrences).toBe(1);
    } finally {
      await exitTui(terminal).catch(() => terminal.closeQuiet());
      announceArtifacts();
      cleanup(cwd);
    }
  });

  it('prints the startup header once, before the TUI takes over', async () => {
    const cwd = makeWorkspace({ stubKey: true });
    const terminal = await launchTui(cwd);
    try {
      // The identity line lands in scrollback before Ink owns the frame (on a
      // 30-row terminal Ink's first paint scrolls the remaining header lines
      // out of the buffer; their formatting is unit-tested separately).
      const full = await terminal.text({ full: true });
      expect(full).toContain('nova ');
      expect(full).toContain('e2e/');
      expect(full.match(/nova \d+\.\d+\.\d+/)).not.toBeNull();
    } finally {
      await exitTui(terminal).catch(() => terminal.closeQuiet());
      announceArtifacts();
      cleanup(cwd);
    }
  });

  it('fullscreen mode renders a scrollable viewport with a long history', async () => {
    // Deterministic: the history is written by hand, no LLM involved.
    const cwd = makeWorkspace({ stubKey: true });
    const sessionsDir = path.join(cwd, '.nova', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) {
      lines.push(JSON.stringify({ role: 'user', content: 'HISTORY-USER-' + String(i) }));
      lines.push(JSON.stringify({ role: 'assistant', content: 'HISTORY-ANSWER-' + String(i) }));
    }
    fs.writeFileSync(
      path.join(sessionsDir, 'session-2020-01-01T00-00-00-000Z.jsonl'),
      lines.join('\n') + '\n',
      'utf-8',
    );

    const terminal = await launchTui(cwd, { cols: 100, rows: 24, args: ['--resume', '--tui-mode', 'fullscreen'] });
    try {
      // The newest message is visible (follow-end) ...
      await terminal.getByText('HISTORY-ANSWER-30', { regex: false }).expect({ timeout: 30_000 });
      // ... and the earlier ones are hidden behind the viewport hint.
      expect(await terminal.text()).toContain('earlier message');
      // PageUp scrolls back into the history.
      await terminal.keyboard.press('PageUp');
      await terminal.keyboard.press('PageUp');
      await new Promise((r) => setTimeout(r, 400));
      const scrolled = await terminal.text();
      expect(scrolled).not.toContain('HISTORY-ANSWER-30');
      expect(scrolled).toMatch(/HISTORY-(ANSWER|USER)-\d+/);
      // The editor stays usable in fullscreen.
      await terminal.getByText('Type a message', { regex: true }).expect();
    } finally {
      await exitTui(terminal).catch(() => terminal.closeQuiet());
      announceArtifacts();
      cleanup(cwd);
    }
  });
});
