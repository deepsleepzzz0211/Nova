# End-to-end tests (tests/e2e)

Nova has three E2E layers. They drive the **built binary** (`dist/index.js`), not the
sources, so a build is required before running any of them:

```bash
pnpm build
```

| Layer | Command | Needs an API key? | Runs in CI? |
|---|---|---|---|
| Smoke (in-process, full stack) | `pnpm test:smoke` | yes (`NOVA_SMOKE_API_KEY`) | no |
| Print mode (subprocess, one turn) | `pnpm test:e2e` | only for the LLM cases | LLM cases skip |
| TUI deterministic (real PTY, no LLM) | `pnpm test:e2e:deterministic` | **no** | **yes** (ubuntu + windows) |
| TUI interaction (real PTY, real LLM) | `pnpm test:e2e:llm` | **yes** | no — local only |

## Policy: real model calls stay out of CI

The repository holds **no API keys** and no CI workflow injects one. `pnpm test:e2e:llm`
is a deliberate local action; running it in CI would expose the credential to every
workflow and burn quota on every push. CI therefore runs the deterministic PTY suite
only, which covers the terminal-level behaviour that unit tests cannot reach (real
frames, keystrokes, resize).

## Running the real-LLM suite locally

```powershell
# PowerShell
$env:WEIXIN_API_KEY = "<your key>"
pnpm test:e2e:llm
```

```bash
# bash / zsh
export WEIXIN_API_KEY=<your key>
pnpm test:e2e:llm
```

A missing key is an **error** here (with setup instructions), not a silent skip. Use
`pnpm test:e2e` to run everything and let the LLM cases skip.

### What it costs and how long it takes

Each interaction case is 2–5 model calls (one per agent round plus tool rounds), so a
full run is roughly 15–25 calls and takes 1–3 minutes. The suite is serial on purpose.

### Endpoint configuration

Defaults target the provider used during development; all three can be overridden:

| Variable | Meaning | Default |
|---|---|---|
| `NOVA_E2E_KEY_ENV` | name of the env var holding the key | `WEIXIN_API_KEY` |
| `NOVA_E2E_BASE_URL` | OpenAI-compatible base URL | `https://chatapi.weixin.qq.com/openai/v1` |
| `NOVA_E2E_MODEL` | model spec handed to the CLI (`provider/model`) | `Deepseek-v4-flash` |

### When the provider throttles you

Free or low tiers will hit rate limits mid-suite. A throttled case **skips with a
note** instead of failing, so a run can be partially green; re-run later or use a key
with more headroom. If several cases skip, the provider is throttling, not the code.

## Failure evidence

Screenshots (SVG) and recordings (`.cast`) are written to:

```
%TEMP%\nova-e2e-artifacts\        # Windows
$TMPDIR/nova-e2e-artifacts/       # macOS / Linux
```

The directory is deliberately outside each test's temp workspace, which is deleted
during cleanup. tui-test also prints the failing screen into the test output.

## Rotating the key

1. Issue a new key with the provider.
2. Update your local environment (`WEIXIN_API_KEY` or the variable named by
   `NOVA_E2E_KEY_ENV`).
3. Revoke the old key.
4. Nothing in the repository or CI needs changing — no key is stored there.

## Writing a new case

- Prefer a **deterministic** case (no LLM) in `tests/e2e/tui/tui-deterministic.test.ts`;
  it then guards CI too.
- Assert **app-generated strings only** (dialog options, pipeline messages, listing
  headers, fold counters). Never assert model wording — such a case passes for the
  wrong reason and hides real bugs.
- Wait for a known state between keystrokes (`waitIdle`, `wait({ state: 'hidden' })`):
  consecutive keys can be coalesced into one escape sequence.
- `NOVA_HOME` is pointed at a temp workspace that seeds its own catalog, so runs never
  touch your `~/.nova`.
