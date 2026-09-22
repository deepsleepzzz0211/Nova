import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawn } from 'node:child_process';
import {
  makeWorkspace,
  launchTui,
  exitTui,
  announceArtifacts,
  cleanup,
  PROVIDER,
  MODEL_ID,
} from './harness.js';

/** Poll the fixture mock until it accepts connections (or timeout). */
async function waitForMock(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.get(
        `http://127.0.0.1:${port}/v1/noop`,
        (res: { destroy(): void }) => {
          res.destroy();
          resolve(true);
        },
      );
      req.on('error', () => resolve(false));
      req.setTimeout(500, () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`mock server on ${port} not ready`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * Deterministic TUI E2E: real PTY, NO LLM calls and NO API key, so it runs in
 * CI on every PR (ubuntu + windows). These cases cover behaviour that needs a
 * real terminal (width handling, command listing) and are the safety net for
 * the terminal-level fixes found during the streaming/TUI work.
 */
describe('TUI deterministic cases (real PTY, no LLM)', () => {
  it('approval decision closes the dialog immediately and settles the tool row (approval-flow 01)', async () => {
    // Fixture mock: turn 2 answers only after ~4s, so a dialog that hides
    // before the turn ends can only have been closed BY the decision.
    const port = 8793;
    const server = spawn(
      process.execPath,
      [path.join(process.cwd(), 'tests', 'e2e', 'tui', 'fixtures', 'mock-approval.mjs')],
      { env: { ...process.env, MOCK_PORT: String(port) }, stdio: ['ignore', 'ignore', 'inherit'] },
    );
    // Poll readiness instead of a blind sleep: spawn failures surface via the
    // fixture's stderr (inherited) plus this timeout.
    await waitForMock(port, 5_000);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-approval-'));
    fs.mkdirSync(path.join(cwd, '.nova'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.nova', 'models.json'),
      JSON.stringify({
        providers: {
          [PROVIDER]: {
            baseUrl: `http://127.0.0.1:${port}/v1`,
            api: 'openai-completions',
            apiKey: 'mock-key',
            models: [{ id: MODEL_ID, contextWindow: 32768, maxTokens: 4096 }],
          },
        },
      }),
      'utf8',
    );
    const terminal = await launchTui(cwd);
    try {
      await terminal.type('run the echo');
      await terminal.keyboard.press('Enter');
      await terminal.getByText('Approval — bash', { regex: true }).expect({ timeout: 60_000 });
      await terminal.keyboard.press('2'); // Allow once
      // THE discriminator: hidden within 2.5s proves the decision closed it
      // (the mock's turn 2 — and thus turn end — lands at ~4s+).
      await terminal.getByText('Approval —').wait({ state: 'hidden', timeout: 2_500 });
      await terminal.getByText('APPROVAL-DONE', { regex: true }).expect({ timeout: 60_000 });
      await terminal.waitIdle({ timeout: 20_000 }).catch(() => undefined);
      const screen = await terminal.text({ full: true });
      const bashLines = screen.split('\n').filter((l) => l.includes('Bash'));
      expect(bashLines.some((l) => l.includes('✓ Bash'))).toBe(true);
      expect(bashLines.some((l) => /[⠋⠙⠹⠸⠼⠴⠦⠏]/.test(l))).toBe(false);
    } finally {
      await exitTui(terminal).catch(() => terminal.closeQuiet());
      announceArtifacts();
      cleanup(cwd);
      server.kill();
    }
  });

  it('narrow terminal (78 columns) wraps the editor instead of truncating', async () => {
    const cwd = makeWorkspace({ stubKey: true });
    const terminal = await launchTui(cwd, { cols: 100, rows: 30 });
    try {
      await terminal.resize(78, 24);
      await terminal.getByText('Type a prompt', { regex: true }).expect();

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

  it('shift+tab cycles the approval mode badge (tui-redesign 10)', async () => {
    const cwd = makeWorkspace({ stubKey: true });
    const terminal = await launchTui(cwd);
    try {
      await terminal.getByText('Type a prompt').expect({ timeout: 60_000 });
      await terminal.getByText('default', { regex: true }).expect();
      await terminal.keyboard.press('Shift+Tab');
      await terminal.getByText('accept edits', { regex: true }).expect({ timeout: 10_000 });
      await terminal.keyboard.press('Shift+Tab');
      await terminal.getByText('plan', { regex: true }).expect({ timeout: 10_000 });
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

  it('shows the welcome card as the transcript opener (tui-redesign 06)', async () => {
    const cwd = makeWorkspace({ stubKey: true });
    const terminal = await launchTui(cwd);
    try {
      await terminal.getByText('Type a prompt').expect({ timeout: 60_000 });
      // The card lives INSIDE the frame now: logo, meta line with version
      // and provider/model, and a tip; the old stdout header is gone.
      const full = await terminal.text({ full: true });
      expect(full).toContain('███╗');
      expect(full).toMatch(/v\d+\.\d+\.\d+ · e2e\//);
      expect(full).toContain('Tip:');
      // Rendered exactly once (not reprinted on repaint).
      expect(full.split('Tip:').length - 1).toBe(1);
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
      await terminal.getByText('Type a prompt', { regex: true }).expect();
    } finally {
      await exitTui(terminal).catch(() => terminal.closeQuiet());
      announceArtifacts();
      cleanup(cwd);
    }
  });
  it('fullscreen extras: inline transcript search', async () => {
    const cwd = makeWorkspace({ stubKey: true });
    const sessionsDir = path.join(cwd, '.nova', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) {
      lines.push(JSON.stringify({ role: 'user', content: 'SCROLL-USER-' + String(i) }));
      lines.push(JSON.stringify({ role: 'assistant', content: 'NEEDLE-' + String(i) + ' answer' }));
    }
    fs.writeFileSync(
      path.join(sessionsDir, 'session-2020-01-01T00-00-00-000Z.jsonl'),
      lines.join('\n') + '\n',
      'utf-8',
    );

    const terminal = await launchTui(cwd, { cols: 100, rows: 24, args: ['--resume', '--tui-mode', 'fullscreen'] });
    try {
      await terminal.getByText('NEEDLE-30', { regex: false }).expect({ timeout: 30_000 });

      // Ctrl+F opens the inline search (retrying expectations, no sleeps).
      await terminal.keyboard.press('Ctrl+F');
      await terminal.getByText('/ search:', { regex: false }).expect({ timeout: 15_000 });
      await terminal.type('NEEDLE-7');
      await terminal.getByText('/ search: NEEDLE-7 (1/1)', { regex: false }).expect({ timeout: 15_000 });
      // The transcript narrows to the matching message only.
      const searched = await terminal.text();
      expect(searched).toContain('NEEDLE-7');
      expect(searched).not.toContain('NEEDLE-30');
      // n/N step through matches (wrapping) and Esc returns to the transcript.
      await terminal.keyboard.press('n');
      await terminal.getByText('/ search: NEEDLE-7 (1/1)', { regex: false }).expect({ timeout: 10_000 });
      await terminal.keyboard.press('Escape');
      await terminal.getByText('NEEDLE-30', { regex: false }).expect({ timeout: 15_000 });
    } finally {
      await exitTui(terminal).catch(() => terminal.closeQuiet());
      announceArtifacts();
      cleanup(cwd);
    }
  });
});
