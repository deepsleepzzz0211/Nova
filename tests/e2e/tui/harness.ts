import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TuiTest, uniqueSession } from '@microsoft/tui-test';

/**
 * Shared harness for the PTY-based E2E suites (tickets e2e-testing 02/03).
 *
 * Runs the BUILT binary in a real PTY against a real LLM endpoint, in an
 * isolated NOVA_HOME that seeds its own provider catalog (never touches the
 * developer's ~/.nova). Assertions are structural invariants only.
 *
 * Endpoint configuration comes from the environment with defaults, so the
 * suite is not welded to one provider:
 *   NOVA_E2E_KEY_ENV    name of the env var holding the API key (default WEIXIN_API_KEY)
 *   NOVA_E2E_BASE_URL   OpenAI-compatible base URL
 *   NOVA_E2E_MODEL      provider/model spec passed to the CLI
 */

export const KEY_ENV = process.env.NOVA_E2E_KEY_ENV ?? 'WEIXIN_API_KEY';
export const BASE_URL = process.env.NOVA_E2E_BASE_URL ?? 'https://chatapi.weixin.qq.com/openai/v1';
export const PROVIDER = 'e2e';
export const MODEL_ID = (process.env.NOVA_E2E_MODEL ?? 'Deepseek-v4-flash').split('/').pop() ?? 'Deepseek-v4-flash';
export const MODEL_SPEC = `${PROVIDER}/${MODEL_ID}`;
export const BINARY = path.resolve('dist', 'index.js');
export const apiKey = process.env[KEY_ENV];
export const hasKey = typeof apiKey === 'string' && apiKey.length > 0;
/** Message shown when the suite skips for lack of credentials. */
export const MISSING_KEY_NOTE = `${KEY_ENV} is not set`;

/**
 * Failure evidence lives OUTSIDE the workspace: `cleanup()` deletes the
 * workspace, which previously deleted the screenshots/recordings tui-test
 * had just written (review finding).
 */
export const ARTIFACTS_DIR = path.join(os.tmpdir(), 'nova-e2e-artifacts');

const TIMEOUTS = { text: 60_000, idle: 20_000, command: 60_000, exit: 60_000, ready: 60_000 };

export interface WorkspaceOptions {
  /**
   * Use a literal placeholder key instead of the env reference, so no-LLM
   * cases (editor wrapping, /model listing) run without a secret. Never used
   * for a real request.
   */
  stubKey?: boolean;
}

export function makeWorkspace(options: WorkspaceOptions = {}): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-tui-e2e-'));
  const novaDir = path.join(cwd, '.nova');
  fs.mkdirSync(novaDir, { recursive: true });
  fs.writeFileSync(
    path.join(novaDir, 'models.json'),
    JSON.stringify(
      {
        providers: {
          [PROVIDER]: {
            api: 'openai-completions',
            baseUrl: BASE_URL,
            apiKey: options.stubKey === true ? 'e2e-placeholder-key' : `$${KEY_ENV}`,
            models: [
              {
                id: MODEL_ID,
                name: `${MODEL_ID} (E2E)`,
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
    artifacts: { dir: ARTIFACTS_DIR, onFailure: 'svg' },
    recording: { mode: 'on-failure', directory: ARTIFACTS_DIR },
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

/**
 * Leave the TUI through its own shortcut (Ctrl+C on an empty editor) and
 * close the session: without closeQuiet the failure recording is never
 * finalised and the session leaks (review finding).
 */
export async function exitTui(terminal: TuiTest): Promise<void> {
  await terminal.keyboard.press('Ctrl+C');
  await terminal.waitExit({ timeout: 20_000 });
  await terminal.closeQuiet();
}

export async function isRateLimited(terminal: TuiTest): Promise<boolean> {
  const text = await terminal.text();
  return /rate limit|too many requests|429|quota exceeded|insufficient/i.test(text);
}

/**
 * Let the screen settle, then skip the case when the provider throttled us.
 * MUST be called before the first expectation a throttled provider could
 * never satisfy (review finding: earlier guards sat after such expectations
 * and therefore never fired).
 */
export async function skipIfThrottled(
  terminal: TuiTest,
  skip: (note?: string) => void,
): Promise<boolean> {
  await terminal.waitIdle({ timeout: 30_000 }).catch(() => undefined);
  if (await isRateLimited(terminal)) {
    skip('provider rate limited');
    return true;
  }
  return false;
}

export function cleanup(cwd: string): void {
  fs.rmSync(cwd, { recursive: true, force: true });
}
