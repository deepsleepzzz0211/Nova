# Nova

CLI AI Agent built with Ink and React — streaming LLM chat with tool use in the terminal.

## Features

- **Streaming agent loop** — token-by-token output, multi-round tool calling with parallel execution
- **Built-in tools** — `read_file`, `write_file`, `edit_file`, `bash`, `web_search` (Tavily), `web_fetch`, `todo_write`, `spawn_subagent`
- **MCP support** — connect Model Context Protocol servers, tools bridge into the same pipeline
- **Context engineering** — reserve-based auto-compaction (zero-LLM tool-result clearing → structured summary → truncation fallback), reactive recovery on context overflow, tool-result truncation with `[PARTIAL]` markers, `/compact` manual trigger
- **Cross-session memory** — `memory_write` persists durable facts to `MEMORY.md` (user + project level), auto-loaded into the next session's prompt
- **Session management** — `--list` prints sessions, `--resume` opens an interactive picker, compaction checkpoints survive resume
- **Undo** — `/undo [n]` reverts the last n conversation turns (conversation only; code changes stay — use git)
- **Prompt-cache friendly** — frozen system prompt, append-only history, Anthropic `cache_control` breakpoints, live R/W/CH metrics
- **Permission system** — policy-based gating with per-tool confirmation dialogs, dangerous-command detection
- **Skills** — progressive disclosure of `SKILL.md` knowledge packs
- **Subagents** — independent-context delegation via `spawn_subagent` with derivation guardrails (no recursion, concurrency cap), per-call model routing, live progress events, cancellation, per-agent transcripts and resume (`resumeAgentId`), and prompt-injection output scanning
- **Data-driven model catalog** — declare providers/models in `~/.nova/models.json`, switch at runtime with `/model`
- **Session persistence** — JSONL rollout with `--resume`

## Install

```bash
npm i -g @posuiqianqiu/nova
```

## Quick start

```bash
nova                    # starts the TUI with the default model
nova --resume           # continue the last session
nova --model <id>       # one-off model override
```

TUI commands: `/model`, `/compact`, `/undo [n]`, `/update`

```bash
nova --list             # list previous sessions (scriptable)
nova --resume           # interactive session picker (Enter = most recent)
```

Test layers (unit / print-mode E2E / PTY TUI E2E, and why real-LLM cases stay
local) are documented in [tests/e2e/README.md](tests/e2e/README.md).

### Print mode (non-interactive)

Run a single turn without the TUI — useful in scripts and for the E2E suite:

```bash
nova -p "summarise README.md"                  # stream the answer to stdout
nova -p "create notes.md" --yes                # auto-approve tool permissions
nova -p "hi" --model weixin/Deepseek-v4-flash  # provider/model routing
```

The answer streams to stdout, tool calls run through the normal pipeline
(anything needing permission is denied unless `--yes` is passed), and the
process exits non-zero when the provider reports an error.

## Configuration

User-level `~/.nova/config.toml` (see `config.example.toml`):

```toml
[llm]
provider = "opencode-go"          # any name declared in models.json
base_url = "https://opencode.ai/zen/go/v1"
model = "mimo-v2.5"

[search]
provider = "tavily"
tavily_api_key = "tvly-..."       # free tier at tavily.com
```

Custom providers/models in `~/.nova/models.json`:

```json
{
  "providers": {
    "my-vllm": {
      "baseUrl": "http://localhost:8000/v1",
      "api": "openai-completions",
      "apiKey": "$MY_API_KEY",
      "models": [{ "id": "qwen2.5-coder:7b", "contextWindow": 32768 }]
    }
  }
}
```

Secrets support value resolution: `"$ENV_VAR"` interpolation and `"!command"` execution.

Priority: CLI args > `NOVA_*` env > project `config.toml` > `~/.nova/config.toml` > defaults.

Tuning knobs (all optional, see `config.example.toml`): `[agent] context_reserve_tokens`, `context_keep_recent_tokens`, `subagent_model`, `subagent_max_concurrent`.

Ops notes:
- `NOVA_HOME` relocates the whole `~/.nova` tree (config, sessions, memory, subagent transcripts, skills, models) — useful for portable installs and test isolation.
- Sessions and subagent transcripts older than 30 days are swept at startup.
- Invalid `[agent] context_strategy` / `subagent_max_concurrent` values warn and fall back at startup instead of being silently ignored.

## Development

```bash
pnpm test            # 300+ unit tests (no network)
pnpm test:live       # live network tests
pnpm test:smoke      # full-stack smoke against a real LLM
pnpm test:mutation   # Stryker mutation testing
pnpm build           # bundle to dist/
```

## License

MIT
