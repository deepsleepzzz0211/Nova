# Nova CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a general-purpose CLI AI Agent with TUI, tool execution, MCP support, and skill system.

**Architecture:** Core + Plugin — Agent Loop orchestrates LLM ↔ Tool interaction. Tools, MCP servers, and Skills register through unified interfaces. TUI built with Ink + React.

**Tech Stack:** TypeScript (ESM, strict), Ink 7 + React 18, OpenAI SDK v4+, @modelcontextprotocol/sdk, vitest, tsup, pnpm

**Spec:** `docs/superpowers/specs/2026-06-26-nova-cli-design.md`

**Test code location:** `tests/plan/` — 所有测试代码在 `tests/` 目录下，不在本 plan 文件中。每个 task 的测试文件路径在对应 task 的 `Test:` 行标明。

**阶段性 Git 提交规则：** 每完成一个阶段（Phase）的所有 task 后，必须执行一次 git commit。Phase 划分见底部 Summary 表。

```
Phase Foundation (Tasks 1-4) 完成 → git commit
Phase Tools (Tasks 5-10) 完成 → git commit
Phase Core (Tasks 11-14) 完成 → git commit
Phase Extensions (Tasks 15-16) 完成 → git commit
Phase TUI (Tasks 17-19) 完成 → git commit
Phase Integration (Tasks 20-21) 完成 → git commit
```

---

## Task 1: Project Scaffolding

**Files:** `package.json`, `tsconfig.json`, `tsup.config.ts`, `src/index.tsx`

- [ ] `pnpm init && pnpm add openai @modelcontextprotocol/sdk ink react ink-markdown @mozilla/readability jsdom turndown tiktoken smol-toml && pnpm add -D typescript @types/node @types/react @types/jsdom @types/turndown tsup vitest`
- [ ] Create `tsconfig.json` (ES2022, ESM, strict, JSX react, bundler resolution)
- [ ] Create `tsup.config.ts` (entry: src/index.tsx, format: esm, target: node18)
- [ ] Add scripts to package.json: `build`, `dev`, `test`, `typecheck`, `bin: { nova: ./dist/index.js }`
- [ ] Create minimal `src/index.tsx`: `console.log('Nova v0.1.0')`
- [ ] Verify: `pnpm build && pnpm typecheck`
- [ ] Commit: `chore: project scaffolding with all dependencies`

---

## Task 2: Core Types

**Files:** `src/llm/types.ts`, `src/tools/types.ts`  
**Test:** `tests/plan/types.test.ts`

- [ ] Implement `src/llm/types.ts` — Message (user|assistant|tool|system), ToolCall, ToolDefinition, StreamChunk (text_delta|tool_call_start|tool_call_delta|tool_call_end|error), ChatOptions
- [ ] Implement `src/tools/types.ts` — Tool (name, description, parameters, execute, requiresPermission), ToolResult (content, isError, metadata), ToolContext (workingDirectory, abortSignal), toToolDefinition()
- [ ] Run: `pnpm test tests/plan/types.test.ts` → PASS
- [ ] Commit: `feat: core types for LLM messages, tools, and streaming`

---

## Task 3: Config System

**Files:** `src/config/schema.ts`, `src/config/defaults.ts`, `src/config/loader.ts`  
**Test:** `tests/plan/config.test.ts`

- [ ] `src/config/schema.ts` — AppConfig interface (llm, agent, search, permission, mcpServers), MCPServerConfig
- [ ] `src/config/defaults.ts` — DEFAULT_CONFIG (gpt-4o, maxToolRounds: 50, tavily, etc.)
- [ ] `src/config/loader.ts` — loadConfig(projectDir): reads `config.toml` via smol-toml, deepMerge with defaults, env var overrides (CODEAGENT_API_KEY, CODEAGENT_MODEL, CODEAGENT_BASE_URL)
- [ ] Run: `pnpm test tests/plan/config.test.ts` → PASS
- [ ] Commit: `feat: config system with TOML, env overrides, defaults`

---

## Task 4: LLM Provider

**Files:** `src/llm/provider.ts`, `src/llm/openai.ts`, `src/llm/stream.ts`  
**Test:** `tests/plan/llm.test.ts` (write test for stream parser: mock OpenAI chunks → verify StreamChunk output)

- [ ] `src/llm/provider.ts` — LLMProvider interface: `chat(messages, options): AsyncIterable<StreamChunk>`
- [ ] `src/llm/stream.ts` — parseOpenAIStream(): handles text deltas + multi-chunk tool_call assembly (tracks by index, accumulates argument fragments, yields start/delta/end)
- [ ] `src/llm/openai.ts` — OpenAIProvider class: wraps `openai` SDK, passes tools/model/stream, delegates to parseOpenAIStream
- [ ] Run test → PASS
- [ ] Commit: `feat: LLM provider with OpenAI streaming and tool_call assembly`

---

## Task 5: Tool Registry

**Files:** `src/tools/registry.ts`  
**Test:** `tests/plan/registry.test.ts`

- [ ] ToolRegistry class: register(tool), get(name), getAll(), toToolDefinitions()
- [ ] Run test → PASS
- [ ] Commit: `feat: tool registry`

---

## Task 6: read_file Tool

**Files:** `src/tools/read-file.ts`  
**Test:** `tests/plan/read-file.test.ts`

- [ ] createReadFileTool(): reads file with line numbers, supports offset/limit pagination, detects binary (null byte check in first 8KB), max 1000 lines, requiresPermission → false
- [ ] Run test → PASS
- [ ] Commit: `feat: read_file tool`

---

## Task 7: write_file Tool

**Files:** `src/tools/write-file.ts`  
**Test:** `tests/plan/write-file.test.ts`

- [ ] createWriteFileTool(): overwrite/append modes, auto-mkdir for parent dirs, requiresPermission → true
- [ ] Run test → PASS
- [ ] Commit: `feat: write_file tool`

---

## Task 8: edit_file Tool

**Files:** `src/tools/edit-file.ts`  
**Test:** `tests/plan/edit-file.test.ts`

- [ ] createEditFileTool(): exact string replacement, error if not found or ambiguous (count occurrences), requiresPermission → false
- [ ] Run test → PASS
- [ ] Commit: `feat: edit_file tool`

---

## Task 9: bash Tool

**Files:** `src/tools/bash.ts`  
**Test:** `tests/plan/bash.test.ts`

- [ ] createBashTool(): uses `spawn(shell, ['-c', cmd], { shell: true })`, captures stdout+stderr, returns exit code in metadata, default 60s timeout, cross-platform (cmd on Windows), abort signal support, requiresPermission → true
- [ ] Run test → PASS
- [ ] Commit: `feat: bash tool`

---

## Task 10: web_search & web_fetch

**Files:** `src/tools/web-search.ts`, `src/tools/web-fetch.ts`  
**Test:** `tests/plan/web-tools.test.ts`

- [ ] createWebSearchTool(): DuckDuckGo HTML POST, regex parse results, returns title/url/snippet, requiresPermission → false
- [ ] createWebFetchTool(): fetch → JSDOM → Readability → TurndownService → Markdown, max 500KB, 30s timeout, requiresPermission → false
- [ ] Run test → PASS
- [ ] Commit: `feat: web_search and web_fetch tools`

---

## Task 11: Permission System

**Files:** `src/permission/policy.ts`, `src/permission/dangerous.ts`  
**Test:** `tests/plan/permission.test.ts`

- [ ] `src/permission/dangerous.ts` — DANGEROUS_PATTERNS array (rm -rf, git push --force, sudo, mkfs, dd, chmod 777, curl|bash, shutdown, /dev/sd*, kill -9 1)
- [ ] `src/permission/policy.ts` — PermissionPolicy class: check(toolName, params) → { decision: 'allow'|'deny'|'ask', message? }
  - Policy order: always_allow_commands → dangerous patterns → tool-specific rules → MCP default ask → allow
  - read_file/edit_file/web_* → allow; write_file → ask; bash → pattern match
- [ ] Run test → PASS
- [ ] Commit: `feat: permission system with dangerous command detection`

---

## Task 12: Context Manager

**Files:** `src/agent/context.ts`  
**Test:** `tests/plan/context.test.ts`

- [ ] ContextManager class: countTokens(messages) via tiktoken, truncate(messages) keeps system msg + drops oldest, isNearLimit(tokens) checks 80% threshold
- [ ] Run test → PASS
- [ ] Commit: `feat: context manager with token counting and truncation`

---

## Task 13: System Prompt Builder

**Files:** `src/agent/prompt.ts`  
**Test:** inline verification (build prompt with tools+skills → verify contains tool descriptions and skill list)

- [ ] buildSystemPrompt(tools, skills, customPrompt): generates system prompt with tool descriptions, available skills list, working directory info
- [ ] Commit: `feat: system prompt builder`

---

## Task 14: Agent Loop

**Files:** `src/agent/loop.ts`  
**Test:** `tests/plan/agent-loop.test.ts`

- [ ] AgentLoop class with options: llm, toolRegistry, config, onToken, onToolCall, onToolResult, onPermissionRequest
- [ ] processUserInput(input): append user msg → call LLM streaming → if text: emit tokens → if tool_calls: check permission per call, execute approved in parallel (Promise.all), append results → call LLM again → repeat until text or max rounds
- [ ] Error handling: LLM retry 3x with backoff, tool error as tool result, max rounds stops
- [ ] Run test → PASS
- [ ] Commit: `feat: core agent loop with streaming and parallel tool execution`

---

## Task 15: MCP Integration

**Files:** `src/mcp/client.ts`, `src/mcp/manager.ts`, `src/mcp/tool-bridge.ts`  
**Test:** `tests/plan/mcp.test.ts`

- [ ] `src/mcp/client.ts` — MCPClient: connect via @modelcontextprotocol/sdk StdioClientTransport, listTools(), callTool(), disconnect()
- [ ] `src/mcp/tool-bridge.ts` — createMCPTool(client, mcpTool): wraps MCP tool as standard Tool, names as `mcp_{server}_{tool}`, permission from server config
- [ ] `src/mcp/manager.ts` — MCPManager: startAll() connects all configured servers, registerTools(registry) bridges all MCP tools, stopAll() gracefully disconnects
- [ ] Run test → PASS
- [ ] Commit: `feat: MCP client, manager, and tool bridge`

---

## Task 16: Skill System

**Files:** `src/skills/loader.ts`, `src/skills/registry.ts`, `src/skills/resolver.ts`, `src/skills/installer.ts`  
**Test:** `tests/plan/skills.test.ts`

- [ ] `src/skills/loader.ts` — parse SKILL.md frontmatter (YAML between --- delimiters) → { name, description, content }
- [ ] `src/skills/registry.ts` — SkillRegistry: scan(dir) walks subdirs for SKILL.md, find(name), findByKeywords(query) tokenizes and matches ≥2 overlapping keywords, load(skill) returns full content
- [ ] `src/skills/installer.ts` — installSkill(gitUrl): git clone to ~/.nova/skills/{name}
- [ ] Run test → PASS
- [ ] Commit: `feat: skill system with loader, registry, keyword matching, git install`

---

## Task 17: TUI Foundation

**Files:** `src/tui/App.tsx`, `src/tui/StatusBar.tsx`, `src/tui/InputBar.tsx`, `src/tui/hooks/useAgent.ts`

- [ ] `useAgent.ts` — hook that owns AgentLoop instance, exposes: messages[], isStreaming, sendMessage(), cancelCurrentTool()
- [ ] `StatusBar.tsx` — Ink Box showing model name, working dir, MCP status
- [ ] `InputBar.tsx` — Ink TextInput with Enter to submit, shows cwd prefix, Ctrl+C support
- [ ] `App.tsx` — root component, composes StatusBar + ChatView + InputBar, manages permission dialog state
- [ ] Commit: `feat: TUI foundation - App, StatusBar, InputBar, useAgent hook`

---

## Task 18: Chat & Tool Display

**Files:** `src/tui/ChatView.tsx`, `src/tui/MessageBubble.tsx`, `src/tui/MarkdownText.tsx`, `src/tui/ToolCallView.tsx`

- [ ] `MarkdownText.tsx` — renders Markdown in terminal via ink-markdown
- [ ] `MessageBubble.tsx` — user msg (blue, right-aligned), assistant msg (white, with MarkdownText), tool calls embedded
- [ ] `ToolCallView.tsx` — shows tool name, collapsible params, result, status spinner/checkmark/X
- [ ] `ChatView.tsx` — scrollable list of MessageBubble, auto-scroll on new content
- [ ] Commit: `feat: chat view with markdown rendering and tool call display`

---

## Task 19: Permission Dialog

**Files:** `src/tui/PermissionDialog.tsx`

- [ ] Modal overlay showing: tool name, params, danger reason
- [ ] Three buttons: Allow (a), Deny (d), Always Allow (A)
- [ ] Calls useAgent's permission resolver
- [ ] Commit: `feat: permission confirmation dialog`

---

## Task 20: CLI Entry Point & Wiring

**Files:** `src/index.tsx`, `src/cli/commands.ts`

- [ ] `src/cli/commands.ts` — parseArgs: `--model`, `--config`, `-p` (one-shot), subcommands (init, skill add/list/remove, config set, mcp list/status)
- [ ] `src/index.tsx` — bootstrap: loadConfig → create OpenAIProvider → create ToolRegistry (register all 6 tools) → start MCPManager → scan Skills → render Ink App
- [ ] One-shot mode: `-p "prompt"` processes single input, prints response, exits
- [ ] Commit: `feat: CLI entry point with arg parsing and full wiring`

---

## Task 21: End-to-End Integration Test

**Files:** `tests/plan/integration.test.ts` (already written), `tests/plan/e2e.test.ts`

- [ ] Verify: all 6 tools register → policy gates correctly → ToolDefinitions export works
- [ ] Verify: config loads from TOML → env overrides work
- [ ] Verify: skill registry scans → finds by name/keywords → loads content
- [ ] Run: `pnpm test` → ALL PASS
- [ ] Run: `pnpm build` → success
- [ ] Run: `pnpm typecheck` → no errors
- [ ] Commit: `test: end-to-end integration verification`

---

## Summary

| Phase | Tasks | Description |
|-------|-------|-------------|
| Foundation | 1-4 | Scaffolding, types, config, LLM provider |
| Tools | 5-10 | Registry + 6 built-in tools |
| Core | 11-14 | Permission, context, prompt, agent loop |
| Extensions | 15-16 | MCP integration, skill system |
| TUI | 17-19 | Ink/React UI components |
| Integration | 20-21 | CLI wiring, e2e tests |
