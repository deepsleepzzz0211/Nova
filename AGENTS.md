# AGENTS.md — Nova Project Rules

## Absolute Prohibitions

These rules are NON-NEGOTIABLE. Violating any of them is grounds for stopping work immediately.

### Tests

- **NEVER** modify a test file to make a test pass. If a test fails, fix the implementation, not the test.
- **NEVER** skip a test because "it's not important" or "we'll fix it later."
- **NEVER** write implementation code before the failing test exists. TDD is mandatory.
- **NEVER** commit code where tests are failing.
- **NEVER** delete a test without explicit user approval.

### Code Quality

- **NEVER** use `any` type in TypeScript unless there is literally no other option. Always prefer explicit types.
- **Logging** in `src/`: the only stdout a CLI command writes is output the user asked for (`--list` listings, `--help` text). Diagnostics go to stderr (`console.error`); debug/instrumentation logging never ships.
- **NEVER** hardcode file paths, API keys, or environment-specific values in source code.
- **NEVER** add a dependency without checking if an existing dependency already solves the problem.
- **NEVER** use `// @ts-ignore` or `// @ts-expect-error` without a comment explaining why.
- **NEVER** put business logic in UI components. Keep TUI components purely presentational.

### Git & Commits

- **NEVER** commit `.env`, `config.toml` with real API keys, `node_modules/`, or `dist/`.
- **NEVER** force push, rebase, or reset without explicit user instruction.
- **NEVER** commit directly to `main`/`master`. Changes land via feature branches → PR → required CI checks green → merge（分支保护平台强制，管理员也不例外）.
- **NEVER** amend an existing commit unless the user explicitly asks.
- **NEVER** create empty commits or commits with no meaningful change.
- **NEVER** push to remote unless the user explicitly asks.

### Architecture

- **NEVER** add features not specified in the design spec without user approval.
- **NEVER** bypass the permission system. If a tool needs permission checking, implement it.
- **NEVER** hardcode tool names as strings in multiple places. Use the Tool interface and registry.
- **NEVER** create circular dependencies between modules.
- **NEVER** put MCP protocol details inside the Tool interface. MCP tools go through tool-bridge.ts.
- **NEVER** mix config loading with config usage. Config is loaded once, passed as dependency.

### Process

- **NEVER** claim "done" or "working" without running the verification command and showing output.
- **NEVER** say "should work" — run the test/build and prove it.
- **NEVER** edit a file you haven't read first.
- **NEVER** work on multiple tasks simultaneously. Complete one, commit, then start the next.
- **NEVER** modify the implementation plan (`docs/superpowers/plans/`) without user approval.
- **NEVER** modify this file (`AGENTS.md`) without user approval.

### Security

- **NEVER** execute user-provided shell commands without going through the permission system.
- **NEVER** read files outside the project directory without explicit user instruction.
- **NEVER** send data to external services without user awareness (logging, telemetry, etc.).
- **NEVER** store API keys in code, comments, or git history.
- **NEVER** relax dangerous command patterns in `src/permission/dangerous.ts` without user approval.

---

## Required Practices

### Test Code Location

所有测试代码在 `tests/` 目录下（具体在 `tests/plan/`），不在实现计划 `.md` 文件中，也不在 `src/` 目录下。

### Before Every Commit

1. Run `pnpm test` — all tests must pass
2. Run `pnpm typecheck` — no type errors
3. Review your diff — no accidental changes to unrelated files
4. Commit message follows conventional commits: `feat:`, `fix:`, `test:`, `chore:`, `refactor:`

### Commit Cadence

每完成一个 task/工单即 commit（一个交付点一个 commit），不攒批、不延迟。

### Before Claiming Task Complete

1. All tests for the task pass
2. Implementation matches the spec, not more, not less
3. No placeholder code (TBD, TODO, implement later)
4. Error handling is implemented, not deferred

### When Stuck

1. Stop. Don't guess.
2. Read the spec and plan again.
3. Check if the test is testing the right thing.
4. Ask the user for clarification.
5. Never "try something and see" — investigate first.

---

## Project Conventions

- **Language:** TypeScript, ESM, strict mode
- **Module system:** `"type": "module"` in package.json, `.js` extensions in imports
- **Test framework:** vitest, test files in `tests/plan/`
- **Build:** tsup
- **Package manager:** pnpm
- **Config format:** TOML via `smol-toml`
- **Naming:** camelCase for variables/functions, PascalCase for types/classes/components, kebab-case for files
- **Exports:** Named exports preferred. Default exports only for React components and CLI entry point.

---

## Model Configuration

Nova 支持多种方式配置 LLM 模型（优先级从高到低）：

### 1. CLI 参数

```bash
nova --model gpt-4.1
nova -m claude-sonnet-4-20250514 --base-url https://api.anthropic.com/v1
nova --model o3-mini --api-key sk-xxx
```

### 2. 环境变量

```bash
export NOVA_API_KEY="sk-xxx"
export NOVA_MODEL="gpt-4.1"
export NOVA_BASE_URL="https://api.openai.com/v1"
nova
```

向后兼容旧名称：
- `CODEAGENT_API_KEY` → `NOVA_API_KEY`
- `CODEAGENT_MODEL` → `NOVA_MODEL`
- `CODEAGENT_BASE_URL` → `NOVA_BASE_URL`

### 3. 配置文件

用户级 `~/.nova/config.toml` 或项目级 `./config.toml`（`NOVA_HOME` 环境变量可整体迁移 `~/.nova` 树——config/sessions/memory/subagents/skills/models 都随迁）：


```toml
[llm]
model = "gpt-4o"
base_url = "https://api.openai.com/v1"
# API key 不要写在配置文件，用环境变量
```

配置示例见 `config.example.toml`。
