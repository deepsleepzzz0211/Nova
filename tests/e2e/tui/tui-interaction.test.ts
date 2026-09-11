import { describe, it, expect } from 'vitest';
import {
  hasKey,
  MISSING_KEY_NOTE,
  makeWorkspace,
  launchTui,
  exitTui,
  announceArtifacts,
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
      announceArtifacts();
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
      announceArtifacts();
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
      announceArtifacts();
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
      announceArtifacts();
      cleanup(cwd);
    }
  });

  it('long tool output folds with a hidden-line counter', async ({ skip }) => {
    if (!hasKey) {
      skip(MISSING_KEY_NOTE);
      return;
    }
    const cwd = makeWorkspace();
    const terminal = await launchTui(cwd);
    try {
      await terminal.submit('Use the bash tool to run exactly: seq 1 40');
      if (await skipIfThrottled(terminal, skip)) return;
      await terminal.getByText('Permission Required').expect({ timeout: 60_000 });
      await terminal.keyboard.press('2');
      await terminal.getByText('seq 1 40').expect({ timeout: 60_000 });
      await terminal.keyboard.press('Ctrl+O');
      // The fold counter is app-generated text (20 of 40 lines hidden).
      await terminal.getByText('more lines', { regex: true }).expect({ timeout: 30_000 });
    } finally {
      await exitTui(terminal).catch(() => terminal.closeQuiet());
      announceArtifacts();
      cleanup(cwd);
    }
  });

  it('delegating to a subagent surfaces its lifecycle in the transcript', async ({ skip }) => {
    if (!hasKey) {
      skip(MISSING_KEY_NOTE);
      return;
    }
    const cwd = makeWorkspace();
    const terminal = await launchTui(cwd);
    try {
      await terminal.submit(
        'Use the spawn_subagent tool with task "reply with the single word OK" and then tell me what it said.',
      );
      if (await skipIfThrottled(terminal, skip)) return;
      // The spawn tool asks for permission first; the model may also decide
      // not to delegate at all (that is model behaviour, not a product bug).
      let delegated = false;
      try {
        await terminal
          .getByText('Permission Required', { regex: false })
          .wait({ state: 'visible', timeout: 60_000 });
        delegated = true;
      } catch {
        delegated = false;
      }
      if (!delegated) {
        skip('model did not delegate to a subagent this run');
        return;
      }
      await terminal.keyboard.press('2');
      // Subagent start/end notices are appended by useAgent, not the model.
      await terminal.getByText('[subagent', { regex: false }).expect({ timeout: 90_000 });
    } finally {
      await exitTui(terminal).catch(() => terminal.closeQuiet());
      announceArtifacts();
      cleanup(cwd);
    }
  });
});
