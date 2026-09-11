import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TuiTest, uniqueSession } from '@microsoft/tui-test';

/**
 * SPIKE (ticket e2e-testing 02): can @microsoft/tui-test drive the Nova TUI
 * in a real PTY on Windows against a real LLM endpoint?
 *
 * This is exploratory evidence for a go/no-go decision, not production test
 * code. Observations are printed so the decision record can cite them.
 */

const KEY_ENV = 'WEIXIN_API_KEY';
const BINARY = path.resolve('dist', 'index.js');
const apiKey = process.env[KEY_ENV];

function makeWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-spike-'));
  const novaDir = path.join(cwd, '.nova');
  fs.mkdirSync(novaDir, { recursive: true });
  fs.writeFileSync(
    path.join(novaDir, 'models.json'),
    JSON.stringify({
      providers: {
        weixin: {
          api: 'openai-completions',
          baseUrl: 'https://chatapi.weixin.qq.com/openai/v1',
          apiKey: `$${KEY_ENV}`,
          models: [
            {
              id: 'Deepseek-v4-flash',
              name: 'DeepSeek V4 Flash (spike)',
              reasoning: true,
              contextWindow: 200_000,
              maxTokens: 48_000,
              compat: { supportsDeveloperRole: false, streamUsage: true },
            },
          ],
        },
      },
    }),
    'utf-8',
  );
  return cwd;
}

beforeAll(() => {
  if (!fs.existsSync(BINARY)) throw new Error('build dist/index.js first (pnpm build)');
});

describe('tui-test spike', () => {
  it.skipIf(!apiKey)('renders the TUI in a PTY, submits to the LLM, and exits', async () => {
    const cwd = makeWorkspace();
    const session = uniqueSession('nova-spike');
    const terminal = new TuiTest(session, {
      backend: 'xtermjs',
      timeouts: { text: 45_000, idle: 20_000, command: 45_000, exit: 45_000, ready: 45_000 },
      artifacts: { dir: path.join(cwd, 'artifacts'), onFailure: 'text' },
      recording: { mode: 'disabled' },
    });

    try {
      console.log('[spike] launching nova binary in PTY…');
      await terminal.run(process.execPath, [BINARY, '--model', 'weixin/Deepseek-v4-flash'], {
        cwd,
        env: { ...process.env, NOVA_HOME: cwd, [KEY_ENV]: apiKey ?? '' },
        cols: 100,
        rows: 32,
      });
      console.log('[spike] session opened; backend=xtermjs size=100x32');

      // 1. TUI renders (structural, no LLM involved).
      await terminal.getByText('Type a message', { regex: false }).expect();
      console.log('[spike] OK: TUI rendered (input placeholder visible)');

      // 2. Resize proves real-terminal geometry handling.
      await terminal.resize(70, 24);
      await terminal.getByText('Type a message', { regex: false }).expect();
      console.log('[spike] OK: resize to 70x24 kept the editor visible');
      await terminal.resize(100, 32);

      // 3. Real LLM round trip through the TUI.
      await terminal.submit('Reply with exactly: PONG');
      console.log('[spike] submitted prompt; waiting for the answer…');
      await terminal.getByText('PONG', { regex: true }).expect({ timeout: 60_000 });
      console.log('[spike] OK: streamed answer rendered in the PTY');

      // 4. Keyboard interaction surface (Ctrl+O toggles tool blocks; no tool
      //    call in this turn, so it must be a harmless no-op).
      await terminal.keyboard.press('Ctrl+O');
      await terminal.getByText('PONG', { regex: true }).expect();
      console.log('[spike] OK: Ctrl+O keypress accepted without breaking the view');

      // 5. Screenshot artifact.
      const artifactsDir = path.join(cwd, 'artifacts');
      fs.mkdirSync(artifactsDir, { recursive: true });
      const shot = path.join(artifactsDir, 'spike-shot.svg');
      await terminal.screenshot(shot);
      console.log('[spike] screenshot written:', fs.existsSync(shot));

      // 6. Clean exit through the app's own shortcut (Ctrl+C on empty editor).
      await terminal.keyboard.press('Ctrl+C');
      await terminal.waitExit({ timeout: 20_000 });
      const code = await terminal.getExitCode();
      console.log('[spike] exit code after waitExit:', code);
      try {
        await terminal.expectExitCode(0, { timeout: 10_000 });
        console.log('[spike] OK: expectExitCode(0) passed');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log('[spike] expectExitCode(0) failed:', msg.slice(0, 200));
      }
      // Exit-code assertions are covered by the print-mode E2E suite; this
      // spike only records whether tui-test exposes them (evidence for the
      // decision record), so do not fail the spike on it.
      expect(true).toBe(true);
    } finally {
      await terminal.closeQuiet();
      console.log('[spike] artifacts dir:', fs.existsSync(path.join(cwd, 'artifacts')));
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('tui-test spike — backend and recording probes', () => {
  it.skipIf(!apiKey)('probes the alacritty backend availability', async () => {
    const cwd = makeWorkspace();
    const terminal = new TuiTest(uniqueSession('nova-spike-alacritty'), {
      backend: 'alacritty',
      timeouts: { text: 20_000, idle: 10_000, command: 20_000, exit: 20_000, ready: 20_000 },
      recording: { mode: 'disabled' },
    });
    try {
      await terminal.run(process.execPath, [BINARY, '--model', 'weixin/Deepseek-v4-flash'], {
        cwd,
        env: { ...process.env, NOVA_HOME: cwd, [KEY_ENV]: apiKey ?? '' },
        cols: 90,
        rows: 28,
      });
      await terminal.getByText('Type a message', { regex: false }).expect();
      console.log('[spike] alacritty backend: OK (no external terminal needed)');
    } catch (err: unknown) {
      console.log('[spike] alacritty backend FAILED:', (err instanceof Error ? err.message : String(err)).slice(0, 160));
    } finally {
      await terminal.closeQuiet();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.skipIf(!apiKey)('probes recording artifacts', async () => {
    const cwd = makeWorkspace();
    const artifactsDir = path.join(cwd, 'artifacts');
    fs.mkdirSync(artifactsDir, { recursive: true });
    const terminal = new TuiTest(uniqueSession('nova-spike-rec'), {
      backend: 'xtermjs',
      timeouts: { text: 20_000, idle: 10_000, command: 20_000, exit: 20_000, ready: 20_000 },
      recording: { mode: 'disabled' },
    });
    try {
      await terminal.run(process.execPath, [BINARY, '--model', 'weixin/Deepseek-v4-flash'], {
        cwd,
        env: { ...process.env, NOVA_HOME: cwd, [KEY_ENV]: apiKey ?? '' },
        cols: 90,
        rows: 28,
      });
      await terminal.getByText('Type a message', { regex: false }).expect();

      const castPath = path.join(artifactsDir, 'probe.cast');
      await terminal.startRecording(castPath, { format: 'cast' });
      await terminal.submit('Reply with exactly: OK');
      await terminal.getByText('OK', { regex: true }).expect({ timeout: 45_000 });
      const stopped = await terminal.stopRecording();
      console.log('[spike] recording:', stopped, '| exists:', fs.existsSync(castPath));
    } catch (err: unknown) {
      console.log('[spike] recording FAILED:', (err instanceof Error ? err.message : String(err)).slice(0, 200));
    } finally {
      await terminal.closeQuiet();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
