# Nova

CLI AI Agent built with Ink and React — streaming LLM chat with tool use in the terminal.

## Features

- **Streaming agent loop** — token-by-token output, multi-round tool calling with parallel execution
- **Built-in tools** — `read_file`, `write_file`, `edit_file`, `bash` (background jobs + named sessions), `job_output`, `job_kill`, `grep`, `glob`, `list_dir`, `web_search` (Tavily), `web_fetch`, `todo_write`, `spawn_subagent` (plus `memory_write`, see below; plus `powershell`, registered only on Windows)
- **Windows shell routing** — bash commands run through Git Bash (POSIX syntax, auto-detected; override with `NOVA_SHELL`, escape hatch `NOVA_SHELL=cmd`), with a first-class `powershell` tool (pwsh 7 preferred) for Windows-native commands
- **Code search** — `grep` (ripgrep content search), `glob` (file-name matcher), `list_dir` (directory listing), all on the embedded ripgrep engine run off-thread with a bounded timeout — replacing bash `grep`/`find`/`ls` that broke on Windows
- **MCP support** — connect Model Context Protocol servers, tools bridge into the same pipeline
- **Context engineering** — reserve-based auto-compaction (zero-LLM tool-result clearing → structured summary → truncation fallback), summary requests ride the main chain's cached prefix (prompt-cache hit on compaction rounds), reactive recovery on context overflow, tool-result truncation with `[PARTIAL]` markers, `/compact` manual trigger
- **Cross-session memory** — `memory_write` persists durable facts to `MEMORY.md` (user + project level), auto-loaded into the next session's prompt
- **Session management** — `--list` prints sessions, `--resume` opens an interactive picker, compaction checkpoints survive resume
- **Undo** — `/undo [n]` reverts the last n turns; when those turns changed files, a dialog asks whether to also restore the code from the session's pre-write checkpoints (`~/.nova/file-history/<sessionId>/`, migrated with `NOVA_HOME`, survives `--resume`; externally-edited files are skipped, never clobbered). Launch with `--with-files` to default the dialog to conversation + code. Fully isolated from git: no commits, no `.git` writes.
- **Two-tier sandbox** — `[sandbox] workspace_write = false` turns approvals into a hard path policy (writes outside workspace + `~/.nova` denied, argv-injection-resistant, fail-closed); `os_level = "auto"` additionally drops every shell child to Windows LOW integrity so even script-inlined writes outside the roots are refused by the OS itself (grants auto-restored on exit)
- **Declarative hooks** — `[[hooks]]` in config: `pre_tool_use` can veto a tool call (exit 2 or deny-JSON on stdout, timeouts fail closed), `post_tool_use` output flows back to the model as a note — submit-before-lint / edit-then-test without touching code
- **Your workflows as commands** — `~/.nova/commands/*.md` become slash commands with `$1`/`$ARGUMENTS` prompt templates; `~/.nova/agents/*.toml` define named subagents that can only narrow tools/model/prompt
- **Background jobs & persistent shells** — `bash background:true` returns a job id (`job_output` cursor reads, `job_kill` tree-kills); `bash session:"name"` keeps one live shell per name across calls (cwd/env/functions persist; dead shells rebuild with a `[session restarted]` marker)
- **Machine-readable output** — `nova -p --output-format jsonl` streams v:1 NDJSON events (start/text/tool_call/tool_result/compaction/usage/result/error) with truthful exit codes, so external programs can drive one turn
- **Hierarchical instructions** — project `AGENTS.md` (or `CLAUDE.md`) loads at startup; subdirectory `AGENTS.md` files are injected lazily, append-only, when the agent touches a file under them (32 KiB session budget, deepest-first truncation)
- **Prompt-cache friendly** — frozen system prompt, append-only history, Anthropic `cache_control` breakpoints, live R/W/CH metrics
- **Permission system** — policy-based gating with per-tool confirmation dialogs, dangerous-command detection
- **Skills** — progressive disclosure of `SKILL.md` knowledge packs
- **Subagents** — independent-context delegation via `spawn_subagent` with derivation guardrails (no recursion, concurrency cap), per-call model routing, live progress events, cancellation, per-agent transcripts and resume (`resumeAgentId`), prompt-injection output scanning, and named `~/.nova/agents` definitions that can only narrow tools/model/prompt
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

TUI commands: `/model`, `/undo [n]`, `/compact`, `/update`, `/status`, `/help`

User-defined slash commands: drop a markdown file at `~/.nova/commands/<name>.md`
(migrated with `NOVA_HOME`). Optional front-matter (`description`, `argument_hint`)
drives `/help` and completion; the body is a prompt template with `$1..$9` and
`$ARGUMENTS` slots filled from the argument line (unfilled placeholders stay as
typed). Running `/name args` sends the EXPANDED template as a normal user
message — same trust path as typing it out. Names must be kebab-case; built-in
commands always win a clash (one stderr note per shadowed name); empty or
invalid files are skipped with a warning and never block startup.
```bash
nova --list             # list previous sessions (scriptable)
nova --resume           # interactive session picker (Enter = most recent)
```

Test layers (unit / print-mode E2E / PTY TUI E2E, and why real-LLM cases stay
local) are documented in [tests/e2e/README.md](tests/e2e/README.md).

Named subagents: `~/.nova/agents/<name>.toml` declares a constrained
subagent (`description`, `tools` whitelist, optional `model`, multiline
`prompt`, `read_only`). `spawn_subagent` gains an `agent` parameter that
routes through the definition: the child only ever sees whitelisted tools,
`read_only` strips every write-capability tool (the `fileAccess` bit, not a
name list), and the definition's prompt replaces the generic subagent
guidance. Definitions can only narrow — recursion stays blocked and unknown
agent names error instead of falling back. Example: [examples/agents/reviewer.toml](examples/agents/reviewer.toml).

Persistent shell sessions: `bash` accepts `session: "<name>"` — the same name
reuses one long-lived bash process (cwd, env vars and functions carry over
between calls; `cd build && make` then `./app --check` just works). Commands
are framed by a sentinel line carrying `$?` (spike-proven under Git Bash
pipes); `session_reset: true` drops the shell for a clean start. Idle shells
are recycled after `shell_session_idle_ms` (default 600000) and a shell that
dies mid-session rebuilds on the next call with a `[session restarted]`
marker. Session commands must not read stdin.

### Print mode (non-interactive)

Run a single turn without the TUI — useful in scripts and for the E2E suite:

```bash
nova -p "summarise README.md"                  # stream the answer to stdout
nova -p "create notes.md" --yes                # auto-approve tool permissions
nova -p "hi" --model weixin/Deepseek-v4-flash  # provider/model routing
```

The answer streams to stdout, tool calls run through the normal pipeline
(anything needing permission is denied unless `--yes` is passed), and a
hard provider failure exits non-zero.

For programs that drive nova, `--output-format jsonl` replaces the plain
stream with NDJSON events on stdout (one JSON object per line, schema `v:1`):
`start` → `text`/`tool_call`/`tool_result`/`compaction`/`usage`* → `result`
(or `error` on a hard failure). Events above 64KB are content-truncated with
`truncated:true`, and in jsonl mode the exit code is truthful (`result`
carries `exit_code`, and a turn containing an `[Error:]` token exits 1).
Consuming one run:

```bash
nova --yes -p "read fact.txt and answer the number" --output-format jsonl \\
  | node -e 'require("readline").createInterface({input:process.stdin})
      .on("line", (l) => { const e = JSON.parse(l);
        if (e.ev === "result") console.log(e.text); })'
```

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
