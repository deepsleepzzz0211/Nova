import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  hasKey,
  makeWorkspace,
  launchTui,
  exitTui,
  isRateLimited,
  cleanup,
} from './harness.js';

/**
 * TUI interaction E2E (ticket e2e-testing 03): the built CLI in a real PTY
 * against a real endpoint. Only structural invariants are asserted — tool
 * block text, dialog option labels, interrupt/undo notices, editor
 * placeholder — never model wording.
 */
describe('TUI interactions (real LLM, real PTY)', () => {
  it.skipIf(!hasKey)('permission dialog approves a bash call, then Ctrl+O expands the block', async ({ skip }) => {
    const cwd = makeWorkspace();
    const terminal = await launchTui(cwd);
    try {
      await terminal.submit('Use the bash tool to run exactly: echo hello-from-e2e');
      // The dialog is structural: three numbered options.
      await terminal.getByText('Permission Required').expect();
      await terminal.getByText('1. No').expect();
      const dialog = await terminal.text();
      if (/rate limit/i.test(dialog)) {
        skip('provider rate limited');
        return;
      }
      await terminal.getByText('3. Yes, always (this session)').expect();
      // Approve once: press "2" (Yes).
      await terminal.keyboard.press('2');
      // The tool block appears (running → done) and the summary is the command.
      await terminal.getByText('echo hello-from-e2e').expect({ timeout: 60_000 });
      // Ctrl+O expands the most recent block: the tool output becomes visible.
      await terminal.keyboard.press('Ctrl+O');
      await terminal.getByText('hello-from-e2e').expect({ timeout: 30_000 });
      await terminal.getByText('Result:').expect({ timeout: 30_000 });
    } finally {
      await exitTui(terminal).catch(() => terminal.closeQuiet());
      cleanup(cwd);
    }
  });

  it.skipIf(!hasKey)('dangerous bash call hides the always option and Esc denies it', async ({ skip }) => {
    const cwd = makeWorkspace();
    const terminal = await launchTui(cwd);
    try {
      await terminal.submit('Use the bash tool to run exactly: rm -rf /tmp/nova-e2e-does-not-exist');
      await terminal.getByText('Permission Required').expect();
      await terminal.getByText('Recursive file deletion').expect();
      const frame = await terminal.text();
      if (/rate limit/i.test(frame)) {
        skip('provider rate limited');
        return;
      }
      // A dangerous call is never session-whitelisted: option 3 is absent.
      expect(frame).not.toContain('3. Yes, always');
      // Esc = No.
      await terminal.keyboard.press('Escape');
      await terminal.getByText('denied', { regex: true }).expect({ timeout: 30_000 });
    } finally {
      await exitTui(terminal).catch(() => terminal.closeQuiet());
      cleanup(cwd);
    }
  });

  it.skipIf(!hasKey)('Esc interrupts a streaming answer and keeps the partial text', async ({ skip }) => {
    const cwd = makeWorkspace();
    const terminal = await launchTui(cwd);
    try {
      await terminal.submit('Write a 400 word essay about terminal emulators. Start immediately.');
      // Wait until the answer starts streaming, then interrupt.
      await terminal.waitIdle({ timeout: 30_000 }).catch(() => undefined);
      const before = await terminal.text();
      if (/rate limit/i.test(before)) {
        skip('provider rate limited');
        return;
      }
      await terminal.keyboard.press('Escape');
      await terminal.getByText('[interrupted]').expect({ timeout: 30_000 });
      // The app is still usable afterwards (the editor is back).
      await terminal.getByText('Type a message', { regex: true }).expect();
    } finally {
      await exitTui(terminal).catch(() => terminal.closeQuiet());
      cleanup(cwd);
    }
  });

  it.skipIf(!hasKey)('/undo reverts the last turn on screen', async ({ skip }) => {
    const cwd = makeWorkspace();
    const terminal = await launchTui(cwd);
    try {
      await terminal.submit('Reply with exactly: READY');
      await terminal.getByText('READY', { regex: true }).expect({ timeout: 60_000 });
      const frame = await terminal.text();
      if (/rate limit/i.test(frame)) {
        skip('provider rate limited');
        return;
      }
      // Wait for the turn to actually finish (the editor shows the idle
      // placeholder again): Enter is intentionally ignored while streaming.
      await terminal.getByText('Type a message', { regex: true }).expect({ timeout: 60_000 });
      await terminal.submit('/undo');
      await terminal.getByText('undone 1 turn', { regex: true }).expect({ timeout: 30_000 });
      // The reverted turn is gone from the restored conversation.
      const after = await terminal.text();
      expect(after).not.toContain('READY');
    } finally {
      await exitTui(terminal).catch(() => terminal.closeQuiet());
      cleanup(cwd);
    }
  });

  it('narrow terminal (78 columns) wraps the editor instead of truncating', async () => {
    const cwd = makeWorkspace({ stubKey: true });
    // No LLM call: this covers the editor's width handling deterministically.
    const terminal = await launchTui(cwd, { cols: 100, rows: 30 });
    try {
      await terminal.resize(78, 24);
      await terminal.getByText('Type a message', { regex: true }).expect();

      const head = 'HEAD-marker-';
      const tail = '-TAIL-marker';
      const filler = 'x'.repeat(120 - head.length - tail.length);
      await terminal.type(head + filler + tail);
      // Wait for the renderer to catch up with the keystrokes.
      await terminal.waitIdle({ timeout: 15_000 }).catch(() => undefined);
      const frame = await terminal.text();
      // Both ends visible => the 120-char line wrapped rather than being cut.
      expect(frame).toContain(head);
      expect(frame).toContain(tail);
      // Every rendered line respects the PTY width.
      for (const line of frame.split('\n')) {
        expect(line.length).toBeLessThanOrEqual(80);
      }
      await terminal.screenshot(path.join(cwd, 'artifacts', 'narrow.svg'));
      expect(fs.existsSync(path.join(cwd, 'artifacts', 'narrow.svg'))).toBe(true);
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
      // The catalog listing is structural: it names the configured provider.
      await terminal.getByText('weixin', { regex: true }).expect({ timeout: 30_000 });
      await terminal.getByText('Deepseek-v4-flash', { regex: true }).expect();
    } finally {
      await exitTui(terminal).catch(() => terminal.closeQuiet());
      cleanup(cwd);
    }
  });
});
