import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TuiTest, uniqueSession } from '@microsoft/tui-test';

/**
 * Shared harness for TUI interaction E2E (ticket e2e-testing 03).
 *
 * Runs the BUILT binary in a real PTY against a real LLM endpoint, in an
 * isolated NOVA_HOME that seeds its own provider catalog (never touches the
 * developer's ~/.nova). Assertions are structural invariants only.
 */

export const KEY_ENV = 'WEIXIN_API_KEY';
export const MODEL_SPEC = 'weixin/Deepseek-v4-flash';
export const BINARY = path.resolve('dist', 'index.js');
export const apiKey = process.env[KEY_ENV];
/** Every case needs the key; without it the suite skips with a message. */
export const hasKey = typeof apiKey === 'string' && apiKey.length > 0;

/** Timeouts: the model streams, so text/command budgets are generous. */
const TIMEOUTS = { text: 60_000, idle: 20_000, command: 60_000, exit: 60_000, ready: 60_000 };

/**
 * @param options.stubKey Use a literal placeholder key instead of the env
 *   reference, so no-LLM cases (editor wrapping, /model listing) run without
 *   a secret. Never used for a real request.
 */
export function makeWorkspace(options: { stubKey?: boolean } = {}): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-tui-e2e-'));
  const novaDir = path.join(cwd, '.nova');
  fs.mkdirSync(novaDir, { recursive: true });
  fs.writeFileSync(
    path.join(novaDir, 'models.json'),
    JSON.stringify(
      {
        providers: {
          weixin: {
            api: 'openai-completions',
            baseUrl: 'https://chatapi.weixin.qq.com/openai/v1',
            apiKey: options.stubKey === true ? 'e2e-placeholder-key' : `$${KEY_ENV}`,
            models: [
              {
                id: 'Deepseek-v4-flash',
                name: 'DeepSeek V4 Flash (E2E)',
                reasoning: true,
                contextWindow: 200_000,
                maxTokens: 48_000,
                compat: { supportsDeveloperRole: false, streamUsage: true },
              },
            ],
          },
        },
      },
      null,
      2,
    ),
    'utf-8',
  );
  return cwd;
}

/** Launch the built TUI in a PTY inside `cwd`. */
export async function launchTui(
  cwd: string,
  options: { cols?: number; rows?: number } = {},
): Promise<TuiTest> {
  const terminal = new TuiTest(uniqueSession('nova-tui'), {
    backend: 'xtermjs',
    timeouts: TIMEOUTS,
    // Failure evidence: text + SVG screenshot in the workspace artifacts dir.
    artifacts: { dir: path.join(cwd, 'artifacts'), onFailure: 'svg' },
    recording: { mode: 'on-failure', directory: path.join(cwd, 'artifacts') },
  });
  await terminal.run(process.execPath, [BINARY, '--model', MODEL_SPEC], {
    cwd,
    env: { ...process.env, NOVA_HOME: cwd, [KEY_ENV]: apiKey ?? '' },
    cols: options.cols ?? 100,
    rows: options.rows ?? 32,
  });
  // The editor placeholder proves the TUI finished its first render.
  await terminal.getByText('Type a message', { regex: true }).expect();
  return terminal;
}

/** Leave the TUI through its own shortcut (Ctrl+C on an empty editor). */
export async function exitTui(terminal: TuiTest): Promise<void> {
  await terminal.keyboard.press('Ctrl+C');
  await terminal.waitExit({ timeout: 20_000 });
}

/**
 * Detect provider throttling from the screen so a case can skip instead of
 * failing: free/low-tier keys cannot sustain repeated E2E runs.
 */
export async function isRateLimited(terminal: TuiTest): Promise<boolean> {
  const text = await terminal.text();
  return /rate limit|too many requests|429/i.test(text);
}

export function cleanup(cwd: string): void {
  fs.rmSync(cwd, { recursive: true, force: true });
}
