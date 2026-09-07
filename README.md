# Nova

CLI AI Agent built with Ink and React — streaming LLM chat with tool use in the terminal.

## Features

- **Streaming agent loop** — token-by-token output, multi-round tool calling with parallel execution
- **Built-in tools** — `read_file`, `write_file`, `edit_file`, `bash`, `web_search` (Tavily), `web_fetch`, `todo_write`, `spawn_subagent`
- **MCP support** — connect Model Context Protocol servers, tools bridge into the same pipeline
- **Context engineering** — tiktoken counting, LLM summary compaction (`/compact`), tool-result truncation with `[PARTIAL]` markers
- **Prompt-cache friendly** — frozen system prompt, append-only history, Anthropic `cache_control` breakpoints, live R/W/CH metrics
- **Permission system** — policy-based gating with per-tool confirmation dialogs, dangerous-command detection
- **Skills** — progressive disclosure of `SKILL.md` knowledge packs
- **Subagents** — independent-context delegation via `spawn_subagent`
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

TUI commands: `/model`, `/compact`

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
