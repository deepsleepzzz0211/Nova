import { describe, it, expect } from 'vitest';
import {
  hasKey,
  MISSING_KEY_NOTE,
  makeWorkspace,
  launchTui,
  exitTui,
  skipIfThrottled,
  cleanup,
} from './harness.js';

/**
 * TUI interaction E2E (ticket e2e-testing 03): the built CLI in a real PTY
 * against a real endpoint. Only structural invariants are asserted — labels
 * the app itself renders (dialog options, pipeline messages, notices, the
 * /model listing header) — never model wording.
 *
 * LLM cases skip with an explicit reason when the key is absent; the two
 * deterministic cases (editor wrapping, /model listing) run without one.
 */
describe('TUI interactions (real LLM, real PTY)', () => {
  it('permission dialog approves a bash call, then Ctrl+O expands the block', async ({ skip }) => {
    if (!hasKey) {
      skip(MISSING_KEY_NOTE);
      return;
    }
    const cwd = makeWorkspace();
    const terminal = await launchTui(cwd);
    try {
      await terminal.submit('Use the bash tool to run exactly: echo hello-from-e2e');
      if (await skipIfThrottled(terminal, skip)) return;

      // Structural: the dialog lists three numbered options.
      await terminal.getByText('Permission Required').expect({ timeout: 60_000 });
      await terminal.getByText('1. No').expect();
      await terminal.getByText('3. Yes, always (this session)').expect();

      await terminal.keyboard.press('2'); // Yes
      // The collapsed block shows the command once the call is ready, but the
      // result stays hidden until expansion.
      await terminal.getByText('echo hello-from-e2e').expect({ timeout: 60_000 });
      expect(await terminal.text()).not.toContain('Result:');

      await terminal.keyboard.press('Ctrl+O');
      await terminal.getByText('Result:').expect({ timeout: 30_000 });
    } finally {
      await exitTui(terminal).catch(() => terminal.closeQuiet());
      cleanup(cwd);
    }
  });

  it('dangerous bash call hides the always option and Esc denies it', async ({ skip }) => {
    if (!hasKey) {
      skip(MISSING_KEY_NOTE);
      return;
    }
    const cwd = makeWorkspace();
    const terminal = await launchTui(cwd);
    try {
      await terminal.submit('Use the bash tool to run exactly: rm -rf /tmp/nova-e2e-does-not-exist');
      if (await skipIfThrottled(terminal, skip)) return;

      await terminal.getByText('Permission Required').expect({ timeout: 60_000 });
      await terminal.getByText('Recursive file deletion').expect();
      expect(await terminal.text()).not.toContain('3. Yes, always');

      // Esc = No. Wait for the dialog to close before the next keystroke:
      // back-to-back writes would be parsed as one escape sequence.
      await terminal.keyboard.press('Escape');
      await terminal.getByText('Permission Required').wait({ state: 'hidden', timeout: 30_000 });
      await terminal.keyboard.press('Ctrl+O');
      await terminal.getByText('Permission denied').expect({ timeout: 30_000 });
    } finally {
      await exitTui(terminal).catch(() => terminal.closeQuiet());
      cleanup(cwd);
    }
  });

  it('Esc interrupts a streaming answer and keeps the app usable', async ({ skip }) => {
    if (!hasKey) {
      skip(MISSING_KEY_NOTE);
      return;
    }
    const cwd = makeWorkspace();
    const terminal = await launchTui(cwd);
    try {
      await terminal.submit('Write a 400 word essay about terminal emulators. Start immediately.');
      if (await skipIfThrottled(terminal, skip)) return;

      await terminal.keyboard.press('Escape');
      await terminal.getByText('[interrupted]').expect({ timeout: 30_000 });
      await terminal.getByText('Type a message', { regex: true }).expect();
    } finally {
      await exitTui(terminal).catch(() => terminal.closeQuiet());
      cleanup(cwd);
    }
  });

  it('/undo reverts the last turn on screen', async ({ skip }) => {
    if (!hasKey) {
      skip(MISSING_KEY_NOTE);
      return;
    }
    const cwd = makeWorkspace();
    const terminal = await launchTui(cwd);
    try {
      await terminal.submit('Reply with exactly: READY');
      if (await skipIfThrottled(terminal, skip)) return;
      await terminal.getByText('READY', { regex: true }).expect({ timeout: 60_000 });

      // Wait for the turn to end: Enter is intentionally ignored while streaming.
      await terminal.getByText('Type a message', { regex: true }).expect({ timeout: 60_000 });
      await terminal.submit('/undo');
      await terminal.getByText('undone 1 turn', { regex: true }).expect({ timeout: 30_000 });
    } finally {
      await exitTui(terminal).catch(() => terminal.closeQuiet());
      cleanup(cwd);
    }
  });

  it('narrow terminal (78 columns) wraps the editor instead of truncating', async () => {
    // Deterministic, no LLM: covers the editor's width handling.
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
    // Deterministic, no LLM: only the listing prints "Provider: ...".
    const cwd = makeWorkspace({ stubKey: true });
    const terminal = await launchTui(cwd);
    try {
      await terminal.submit('/model');
      await terminal.getByText('Provider: e2e', { regex: false }).expect({ timeout: 30_000 });
    } finally {
      await exitTui(terminal).catch(() => terminal.closeQuiet());
      cleanup(cwd);
    }
  });
});
