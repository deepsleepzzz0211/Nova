import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TuiTest, uniqueSession } from '@microsoft/tui-test';
import {
  ARTIFACTS_DIR,
  BINARY,
  KEY_ENV,
  MISSING_KEY_NOTE,
  apiKey,
  hasKey,
  launchTui,
  exitTui,
  cleanup,
  makeWorkspace,
} from '../e2e/tui/harness.js';

/**
 * SPIKE evidence (ticket e2e-testing 02): the go/no-go run that proved
 * @microsoft/tui-test drives the Nova TUI in a real PTY on Windows.
 *
 * Kept as regression evidence for the beta dependency — every observation is
 * an assertion, so a future tui-test upgrade that breaks a capability fails
 * here instead of silently degrading the E2E suite.
 */

beforeAll(() => {
  if (!fs.existsSync(BINARY)) throw new Error('build dist/index.js first (pnpm build)');
});

describe('tui-test capability evidence', () => {
  it('renders, resizes and reaches a real LLM in one session', async ({ skip }) => {
    if (!hasKey) {
      skip(MISSING_KEY_NOTE);
      return;
    }
    const cwd = makeWorkspace();
    const terminal = await launchTui(cwd);
    try {
      await terminal.resize(70, 24);
      await terminal.getByText('Type a message', { regex: true }).expect();
      await terminal.resize(100, 32);

      await terminal.submit('Reply with exactly: PONG');
      await terminal.getByText('PONG', { regex: true }).expect({ timeout: 60_000 });
      await terminal.keyboard.press('Ctrl+O');

      fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
      const shot = path.join(ARTIFACTS_DIR, 'spike-shot.svg');
      await terminal.screenshot(shot);
      expect(fs.existsSync(shot)).toBe(true);
    } finally {
      await exitTui(terminal).catch(() => terminal.closeQuiet());
      cleanup(cwd);
    }
  });

  it('records a session as an asciinema cast file', async ({ skip }) => {
    if (!hasKey) {
      skip(MISSING_KEY_NOTE);
      return;
    }
    const cwd = makeWorkspace();
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
    const terminal = new TuiTest(uniqueSession('nova-spike-rec'), {
      backend: 'xtermjs',
      timeouts: { text: 30_000, idle: 15_000, command: 30_000, exit: 30_000, ready: 30_000 },
      recording: { mode: 'disabled' },
    });
    try {
      await terminal.run(process.execPath, [BINARY, '--model', 'e2e/Deepseek-v4-flash'], {
        cwd,
        env: { ...process.env, NOVA_HOME: cwd, [KEY_ENV]: apiKey ?? '' },
        cols: 90,
        rows: 28,
      });
      await terminal.getByText('Type a message', { regex: true }).expect();

      const castPath = path.join(ARTIFACTS_DIR, 'spike-recording.cast');
      await terminal.startRecording(castPath, { format: 'cast' });
      await terminal.submit('Reply with exactly: OK');
      await terminal.getByText('OK', { regex: true }).expect({ timeout: 45_000 });
      const stopped = await terminal.stopRecording();
      expect(stopped).toBe(castPath);
      expect(fs.existsSync(castPath)).toBe(true);
    } finally {
      await exitTui(terminal).catch(() => terminal.closeQuiet());
      cleanup(cwd);
    }
  });

  it('runs on the alacritty backend without an external terminal', async ({ skip }) => {
    if (!hasKey) {
      skip(MISSING_KEY_NOTE);
      return;
    }
    const cwd = makeWorkspace({ stubKey: true }); // no LLM call needed here
    const terminal = new TuiTest(uniqueSession('nova-spike-alacritty'), {
      backend: 'alacritty',
      timeouts: { text: 30_000, idle: 15_000, command: 30_000, exit: 30_000, ready: 30_000 },
      recording: { mode: 'disabled' },
    });
    try {
      await terminal.run(process.execPath, [BINARY, '--model', 'e2e/Deepseek-v4-flash'], {
        cwd,
        env: { ...process.env, NOVA_HOME: cwd },
        cols: 90,
        rows: 28,
      });
      await terminal.getByText('Type a message', { regex: true }).expect();
    } finally {
      await exitTui(terminal).catch(() => terminal.closeQuiet());
      cleanup(cwd);
    }
  });
});
