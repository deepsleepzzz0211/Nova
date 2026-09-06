# Nova CLI Design Spec

## Overview

Nova 是一个通用的 CLI AI Agent，类似 Claude Code / OpenCode / Pi。使用 TypeScript 编写，基于 Ink + React 构建终端 UI，通过 OpenAI 兼容 API 与 LLM 交互。核心能力包括文件读写、命令执行（含危险命令拦截）、网页搜索/抓取、MCP 协议支持、以及可扩展的 Skill 系统。

**目标用户：** 开发者（但不限于写代码 — 可用于任何需要文件操作和命令行的任务）

**技术栈：**
- Language: TypeScript (ESM, strict mode)
- Runtime: Node.js >= 18
- TUI: Ink 7.x + React 18 + ink-markdown (terminal Markdown rendering)
- LLM: OpenAI compatible API (via `openai` npm package v4+)
- MCP: `@modelcontextprotocol/sdk` v1+ (MCP protocol client)
- Search: Tavily API (primary, free tier 1000 req/month) + DuckDuckGo fallback
- Fetch: `@mozilla/readability` + `turndown` (HTML → DOM → Markdown)
- Token counting: `tiktoken` (for context window management)
- Config: TOML format (via `smol-toml` package)
- HTTP: Built-in `fetch` (Node 18+)
- Build: tsup
- Test: vitest
- Package Manager: pnpm

## Architecture

### High-Level

```
+----------------------------------------------------------+
|                   TUI Layer (Ink + React)                 |
|   App > Chat + Input + ToolCall + Permission + Status     |
+----------------------------------------------------------+
|                    Agent Loop (Core)                       |
|   User Input -> LLM Call -> Tool Execution -> Response     |
|   (streaming, max rounds limit, error recovery)            |
+----------+-----------+-----------+------------------------+
|  Tools   |   MCP     |  Skills   |   Permission           |
|  Built-in|  Protocol |  Knowledge|   Danger Detection     |
|  6 tools |  Stdio    |  Markdown |   Pattern Matching     |
+----------+-----------+-----------+------------------------+
|              LLM Provider (OpenAI Compatible API)         |
|              Config (~/.nova/config.toml)            |
+----------------------------------------------------------+
```

### Core Design Principles

1. **Tool-centric:** Everything the agent can do is a tool. Built-in tools, MCP tools, all share the same interface.
2. **Streaming-first:** All LLM interactions are streamed. Text renders character by character.
3. **Safety by default:** Dangerous operations require explicit user confirmation.
4. **Extensible:** New tools via MCP servers, new knowledge via Skills, new LLM providers via Provider interface.

## Project Structure

```
nova/
├── package.json
├── tsconfig.json
├── tsup.config.ts               # Build config
├── .nova/                  # Project-local config
│   └── config.toml
├── src/
│   ├── index.tsx                # CLI entry point (arg parsing, bootstrap)
│   ├── cli/
│   │   └── commands.ts          # CLI subcommands (init, skill add, config, etc.)
│   ├── agent/
│   │   ├── loop.ts              # Core agent loop
│   │   ├── enhanced-loop.ts     # Enhanced agent loop with caching
│   │   ├── context.ts           # Conversation context (messages[], system prompt)
│   │   └── prompt.ts            # System prompt builder (tools description, skills)
│   ├── llm/
│   │   ├── types.ts             # Shared types (Message, ToolCall, ToolResult, etc.)
│   │   ├── provider.ts          # LLMProvider interface
│   │   ├── openai.ts            # OpenAI-compatible implementation
│   │   └── stream.ts            # Stream parsing (text deltas + tool_call deltas)
│   ├── tools/
│   │   ├── types.ts             # Tool interface definition
│   │   ├── enhanced-types.ts    # Enhanced tool interface
│   │   ├── registry.ts          # Tool registry (register, lookup, list)
│   │   ├── execution-pipeline.ts # Tool execution pipeline with caching
│   │   ├── read-file.ts         # read_file tool
│   │   ├── enhanced-read-file.ts # Enhanced read_file tool with caching
│   │   ├── write-file.ts        # write_file tool
│   │   ├── edit-file.ts         # edit_file tool (exact string replacement)
│   │   ├── bash.ts              # bash tool (shell command execution)
│   │   ├── web-search.ts        # web_search tool
│   │   ├── enhanced-web-search.ts # Enhanced web_search tool with multiple providers
│   │   └── web-fetch.ts         # web_fetch tool
│   ├── cache/
│   │   ├── types.ts             # Cache interface and types
│   │   ├── memory-cache.ts      # In-memory cache implementation
│   │   ├── llm-response-cache.ts # LLM response cache
│   │   ├── tool-result-cache.ts # Tool result cache
│   │   ├── context-cache.ts     # Context cache
│   │   ├── monitor.ts           # Cache performance monitor
│   │   └── index.ts             # Cache module exports
│   ├── planning/
│   │   ├── types.ts             # Planning types (Task, Plan, etc.)
│   │   ├── task-decomposer.ts   # Task decomposition using LLM
│   │   ├── planner.ts           # Plan creation and execution
│   │   ├── task-executor.ts     # Task execution using agent loop
│   │   └── index.ts             # Planning module exports
│   ├── subagent/
│   │   ├── types.ts             # Subagent types
│   │   ├── default-subagent.ts  # Default subagent implementation
│   │   ├── pool.ts              # Subagent pool for parallel execution
│   │   └── index.ts             # Subagent module exports
│   ├── mcp/
│   │   ├── types.ts             # MCP types
│   │   ├── client.ts            # MCP client (connect, list tools, call tool)
│   │   ├── manager.ts           # MCP server lifecycle management
│   │   └── tool-bridge.ts       # MCP tool -> Tool interface bridge
│   ├── skills/
│   │   ├── types.ts             # Skill types (SkillMeta, SkillContent)
│   │   ├── loader.ts            # Skill file loader (parse SKILL.md frontmatter)
│   │   ├── registry.ts          # Skill registry (scan directories, register)
│   │   ├── resolver.ts          # Skill resolver (match user request -> load content)
│   │   └── installer.ts         # Third-party skill installer (git clone)
│   ├── tui/
│   │   ├── App.tsx              # Root component
│   │   ├── ChatView.tsx         # Conversation display area
│   │   ├── MessageBubble.tsx    # Single message (user/assistant, with Markdown rendering)
│   │   ├── MarkdownText.tsx     # Terminal Markdown renderer (via ink-markdown)
│   │   ├── ToolCallView.tsx     # Tool call display (name, params, result, status)
│   │   ├── InputBar.tsx         # User input bar (text input + send)
│   │   ├── PermissionDialog.tsx # Permission confirmation dialog
│   │   ├── StatusBar.tsx        # Top status bar (model, session info)
│   │   └── hooks/
│   │       ├── useAgent.ts      # Hook connecting TUI to agent loop
│   │       └── usePermission.ts # Hook for permission flow
│   ├── permission/
│   │   ├── types.ts             # Permission types (Allow, Deny, AlwaysAllow)
│   │   ├── policy.ts            # Policy engine (pattern matching, config-based)
│   │   └── dangerous.ts         # Dangerous command patterns
│   └── config/
│       ├── schema.ts            # Config schema (TypeScript types + validation)
│       ├── loader.ts            # Config file loader (~/.nova/config.toml)
│       └── defaults.ts          # Default config values
├── skills/                      # Built-in skills
│   └── coding/
│       └── SKILL.md
└── tests/
    ├── agent/
    │   ├── loop.test.ts
    │   └── context.test.ts
    ├── tools/
    │   ├── read-file.test.ts
    │   ├── write-file.test.ts
    │   ├── edit-file.test.ts
    │   ├── bash.test.ts
    │   ├── web-search.test.ts
    │   └── web-fetch.test.ts
    ├── cache/
    │   └── cache.test.ts        # Cache system tests
    ├── planning/
    │   └── planning.test.ts     # Planning system tests
    ├── subagent/
    │   └── subagent.test.ts     # Subagent system tests
    ├── mcp/
    │   ├── client.test.ts
    │   └── manager.test.ts
    ├── skills/
    │   ├── loader.test.ts
    │   └── resolver.test.ts
    ├── permission/
    │   └── policy.test.ts
    ├── config/
    │   └── loader.test.ts
    └── integration/
        ├── agent-loop.test.ts   # Full agent loop with mock LLM + real tools
        └── mcp-integration.test.ts  # MCP client + server lifecycle
```

## Component Details

### 1. Agent Loop (`src/agent/loop.ts`)

The core loop orchestrates the conversation between user and LLM.

```typescript
interface AgentLoopOptions {
  llm: LLMProvider;
  toolRegistry: ToolRegistry;
  skillResolver: SkillResolver;
  permissionChecker: PermissionChecker;
  maxToolRounds: number;        // default: 50
  onToken: (token: string) => void;        // streaming text callback
  onToolCall: (call: ToolCall) => void;     // tool call started
  onToolResult: (result: ToolResult) => void; // tool call finished
  onPermissionRequest: (call: ToolCall) => Promise<boolean>; // permission UI
}

class AgentLoop {
  private messages: Message[] = [];
  private systemPrompt: string;

  async processUserInput(input: string): Promise<void>;
  // 1. Append user message to messages[]
  // 2. Call LLM with streaming
  // 3. If text response -> emit tokens via onToken, done
  // 4. If tool_calls -> collect all tool_calls from the response:
  //    a. For each tool_call, check permission via permissionChecker
  //    b. If needs permission -> call onPermissionRequest (sequential, one dialog at a time)
  //    c. If denied -> append denial result, skip execution
  //    d. If allowed -> add to execution queue
  //    e. Execute all allowed tool_calls **in parallel** (Promise.all)
  //    f. Collect all results, append as tool messages
  // 5. Call LLM again with all tool results
  // 6. Repeat from step 3 until text response or max rounds
}
```

**Parallel tool_calls strategy:**
- LLM may return multiple tool_calls in a single response (e.g., read_file + bash simultaneously)
- Permission checks run sequentially (one dialog at a time for UX)
- Approved tool executions run in parallel via `Promise.all` for performance
- All results are collected and appended to messages before the next LLM call

**Context window management (`src/agent/context.ts`):**
- Token counting via `tiktoken` before each LLM call
- When total tokens approach model limit (configurable, default 80% of model max):
  - Strategy 1: Truncate oldest messages (keep system prompt + last N messages)
  - Strategy 2: Summarize older messages into a single "history summary" message
- Default: Strategy 1 (simple truncation), configurable in `[agent] context_strategy = "truncate" | "summarize"`

**Error handling:**
- LLM API error: retry 3 times with exponential backoff, then show error
- Tool execution error: capture error as tool result, let LLM decide how to handle
- Max rounds exceeded: stop and inform user

### 2. LLM Provider (`src/llm/`)

Nova now supports multiple LLM providers through a unified interface, following Pi Agent's modular architecture.

```typescript
interface LLMProvider {
  chat(messages: Message[], options: ChatOptions): AsyncIterable<StreamChunk>;
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
}

interface ProviderCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  vision: boolean;
  maxContextLength: number;
  models: string[];
}

interface ChatOptions {
  model: string;
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
}

type StreamChunk =
  | { type: 'text_delta'; content: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; arguments: string }
  | { type: 'tool_call_end'; id: string }
  | { type: 'error'; error: string };
```

**Supported Providers:**
- **OpenAI:** GPT-4o, GPT-4 Turbo, GPT-3.5 Turbo
- **Anthropic:** Claude 3.5 Sonnet, Claude 3 Opus, Claude 3 Sonnet, Claude 3 Haiku
- **Ollama:** Local models (Llama 3, CodeLlama, Mistral, etc.)

**Provider Registry:**
```typescript
class LLMProviderRegistry {
  register(name: string, providerClass: new (config: ProviderConfig) => LLMProvider): void;
  getProvider(config: ProviderConfig): LLMProvider;
  getAvailableProviders(): string[];
}
```

**Configuration:**
```toml
[llm]
provider = "openai"  # or "anthropic", "ollama"
api_key = "your-api-key"
base_url = "https://api.openai.com/v1"
model = "gpt-4o"
```

### 3. Tool System (`src/tools/`)

```typescript
interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
  requiresPermission?(params: Record<string, unknown>): boolean;
}

interface ToolContext {
  workingDirectory: string;
  abortSignal: AbortSignal;
}

interface ToolResult {
  content: string;              // Text result for LLM
  isError?: boolean;            // Whether this is an error
  metadata?: Record<string, unknown>;  // Extra info for TUI display
}
```

**Tool Registry:**
```typescript
class ToolRegistry {
  register(tool: Tool): void;
  get(name: string): Tool | undefined;
  getAll(): Tool[];
  toToolDefinitions(): ToolDefinition[];  // For LLM tools parameter
}
```

#### Built-in Tools

**read_file:**
- Parameters: `{ path: string, offset?: number, limit?: number }`
- Returns file content with line numbers
- Auto-detects binary files (refuses to read, reports type)
- Max 1000 lines per read; offset/limit for pagination

**write_file:**
- Parameters: `{ path: string, content: string, mode?: 'overwrite' | 'append' }`
- Creates parent directories if needed
- Requires permission on first write per session

**edit_file:**
- Parameters: `{ path: string, old_string: string, new_string: string }`
- Exact string replacement (not regex)
- old_string must be unique in the file
- Returns error if old_string not found or ambiguous

**bash:**
- Parameters: `{ command: string, timeout?: number, working_directory?: string }`
- Implementation: `child_process.spawn(command, { shell: true, cwd: workingDir })`
- Uses system default shell (bash on Linux/Mac, cmd/powershell on Windows)
- Default timeout: 60 seconds (kills process on timeout)
- Captures stdout + stderr as separate streams, merged in output
- Returns exit code (0 = success)
- Permission check: pattern matching against dangerous commands
- Environment: inherits current process env, no modifications

**web_search:**
- Parameters: `{ query: string, num_results?: number }`
- Primary: Tavily API (designed for AI agents, free tier 1000 req/month, no API key for basic use)
- Fallback: DuckDuckGo HTML scraping (no API key, less reliable)
- Returns list of results with title, URL, snippet
- Config: `[search] provider = "tavily" | "duckduckgo"; tavily_api_key = "..."` (optional, free tier works without key)

**web_fetch:**
- Parameters: `{ url: string }`
- Implementation: `fetch(url)` → `@mozilla/readability` (extract main content) → `turndown` (HTML → Markdown)
- Strips navigation, ads, sidebars; keeps article/main content
- Max response size: 500KB
- Timeout: 30 seconds

### 4. Permission System (`src/permission/`)

```typescript
interface PermissionChecker {
  check(toolName: string, params: Record<string, unknown>): PermissionResult;
}

type PermissionResult =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string }
  | { decision: 'ask'; message: string };  // Show dialog to user
```

**Policy rules (evaluated in order):**

1. **Always-allow list** (from config): Commands matching `always_allow_commands` are auto-approved
2. **Dangerous pattern matching**: Commands matching dangerous patterns get `ask`
3. **Tool-specific rules**:
   - `read_file`: Always allow
   - `write_file`: **Overwriting existing file** → always `ask`; **Creating new file** → `allow` (configurable via `auto_approve_file_write`)
   - `edit_file`: Always allow
   - `bash`: Pattern-based (see dangerous patterns)
   - `web_search` / `web_fetch`: Always allow
4. **MCP tools**: Default to `ask` (configurable per server with `auto_approve`)
5. **Default**: Allow

**Dangerous patterns:**
```typescript
const DANGEROUS_PATTERNS = [
  { pattern: /\brm\s+(-[rRf]+\b|--recursive)/, reason: 'Recursive file deletion' },
  { pattern: /\bgit\s+push\s+.*--force/, reason: 'Force push (may overwrite remote history)' },
  { pattern: /\bmkfs\b/, reason: 'Disk formatting' },
  { pattern: /\bdd\s+/, reason: 'Raw disk write' },
  { pattern: /\bchmod\s+777/, reason: 'Setting world-writable permissions' },
  { pattern: /\b(curl|wget)\s+.*\|\s*(bash|sh|python|node)/, reason: 'Piping remote content to shell' },
  { pattern: /\bsudo\b/, reason: 'Elevated privileges' },
  { pattern: /\b(shutdown|reboot|halt)\b/, reason: 'System shutdown' },
  { pattern: />\s*\/dev\/sd[a-z]/, reason: 'Writing directly to disk device' },
  { pattern: /\bkill\s+-9\s+1\b/, reason: 'Killing init process' },
];
```

### 5. MCP Integration (`src/mcp/`)

**MCP Client:** Communicates with MCP servers via stdio transport.

```typescript
class MCPClient {
  constructor(serverConfig: MCPServerConfig);
  async connect(): Promise<void>;
  async listTools(): Promise<MCPTool[]>;
  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult>;
  async disconnect(): Promise<void>;
}

class MCPManager {
  async startAll(): Promise<void>;       // Start all configured servers
  async stopAll(): Promise<void>;         // Gracefully stop all servers
  registerTools(registry: ToolRegistry): void; // Register MCP tools into main registry
}
```

**MCP tool bridge:** Each MCP tool is wrapped into the standard `Tool` interface:
```typescript
function createMCPTool(client: MCPClient, mcpTool: MCPTool): Tool {
  return {
    name: `mcp_${client.name}_${mcpTool.name}`,
    description: mcpTool.description,
    parameters: mcpTool.inputSchema,
    execute: (params) => client.callTool(mcpTool.name, params),
    requiresPermission: () => !client.config.autoApprove,
  };
}
```

### 6. Skill System (`src/skills/`)

Skills are knowledge documents (Markdown) that guide the agent's behavior for specific tasks.

```typescript
interface SkillMeta {
  name: string;
  description: string;    // Used for matching (when to load this skill)
  path: string;           // Path to SKILL.md
}

class SkillRegistry {
  async scan(): Promise<void>;           // Scan all skill directories
  find(query: string): SkillMeta[];      // Find matching skills
  load(skill: SkillMeta): Promise<string>; // Load full content
}
```

**Skill directories (in priority order):**
1. `~/.nova/skills/` — User-installed skills
2. `<project>/.nova/skills/` — Project-local skills
3. Built-in skills (bundled with the package)

**Third-party skill installation:**
```bash
nova skill add <git-url>       # Clone skill repo to ~/.nova/skills/
nova skill list                # List installed skills
nova skill remove <name>       # Remove a skill
```

**Skill loading flow:**
1. At startup: scan all skill directories, parse frontmatter, build registry
2. When building system prompt: include skill list (name + description) in system prompt as available knowledge
3. When LLM indicates it needs a skill (or user requests one): load full SKILL.md content into context
4. **Matching strategy:** Exact name match first, then keyword match — tokenize user input and skill descriptions (split on whitespace/punctuation), compute intersection. Return skills with ≥2 overlapping keywords, sorted by overlap count. No embedding-based matching in v1.

### 7. TUI Components (`src/tui/`)

Built with Ink + React. Each component is a React functional component.

**App.tsx** — Root component:
- Manages global state (messages, current model, permission dialog)
- Renders StatusBar, ChatView, InputBar, PermissionDialog (when active)

**ChatView.tsx** — Scrollable conversation area:
- Renders list of MessageBubble components
- Auto-scrolls to bottom on new content
- Shows streaming text in real-time

**MessageBubble.tsx** — Single message:
- User messages: right-aligned, colored
- Assistant messages: left-aligned, with markdown rendering
- Tool calls: embedded as ToolCallView

**ToolCallView.tsx** — Tool call display:
- Shows tool name, parameters (collapsible), result, status
- Status indicators: running (spinner), success (checkmark), error (X)

**InputBar.tsx** — User input:
- Text input with Enter to send
- Shows current working directory
- Supports Ctrl+C to cancel current operation

**PermissionDialog.tsx** — Modal permission prompt:
- Shows tool name, parameters, danger reason
- Three buttons: Allow, Deny, Always Allow (this session)
- Keyboard shortcuts: a=allow, d=deny, A=always allow

**StatusBar.tsx** — Top bar:
- Model name, token usage (if available)
- Current working directory
- MCP server connection status

### 8. Configuration (`src/config/`)

```typescript
interface AppConfig {
  llm: {
    apiKey: string;
    baseUrl: string;       // default: "https://api.openai.com/v1"
    model: string;         // default: "gpt-4o"
    maxTokens: number;     // default: 4096
    temperature: number;   // default: 0
  };
  agent: {
    maxToolRounds: number; // default: 50
    systemPrompt: string;  // additional system prompt
    contextStrategy: 'truncate' | 'summarize'; // default: "truncate"
  };
  search: {
    provider: 'tavily' | 'duckduckgo'; // default: "tavily"
    tavilyApiKey?: string;              // optional, free tier works without
  };
  permission: {
    autoApproveFileWrite: boolean;  // default: false
    autoApproveBash: boolean;       // default: false
    alwaysAllowCommands: string[];  // default: ["git status", "git diff", "ls"]
  };
  mcpServers: MCPServerConfig[];
}

interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  autoApprove?: boolean;  // default: false
}
```

**Config file locations (in priority order):**
1. Environment variables: `CODEAGENT_API_KEY`, `CODEAGENT_MODEL`, etc.
2. `<project>/.nova/config.toml` — Project config
3. `~/.nova/config.toml` — User config
4. Defaults

### 9. CLI Commands

```bash
# Start interactive session (default)
nova

# Start with a specific model
nova --model gpt-4o-mini

# One-shot mode (non-interactive)
nova -p "explain this codebase"

# Configuration
nova config init          # Create default config file
nova config set <key> <value>

# Skill management
nova skill add <git-url>
nova skill list
nova skill remove <name>

# MCP management
nova mcp list             # List configured MCP servers
nova mcp status           # Show connection status
```

## Data Flow Example

```
User types: "Create a hello.ts file with a greeting function"

1. TUI InputBar captures input
2. Agent loop appends user message to messages[]
3. Agent builds system prompt (includes tool descriptions)
4. Agent calls LLM: POST /v1/chat/completions (streaming)
5. LLM returns tool_call: write_file({ path: "hello.ts", content: "..." })
6. Agent checks permission -> write_file (creating new file) -> allow (no dialog needed)
7. Agent executes write_file tool -> file created
9. Agent appends tool result to messages[]
10. Agent calls LLM again with tool result
11. LLM returns text: "Created hello.ts with a greet function."
12. TUI ChatView renders the response
13. Agent loop ends, waits for next user input
```

## Error Scenarios

| Scenario | Handling |
|----------|----------|
| LLM API key invalid | Show error at startup, direct to `nova config` |
| LLM API timeout | Retry 3x with backoff, then show error |
| LLM rate limited | Show wait time, auto-retry |
| Tool execution fails | Capture error as tool result, LLM sees it and adjusts |
| MCP server crash | Log error, mark server disconnected, continue without its tools |
| File not found (read) | Return error to LLM (it may try a different path) |
| Permission denied by user | Return denial message to LLM |
| Max tool rounds exceeded | Stop loop, inform user |
| Ctrl+C during LLM call | Abort current request, return to input |
| Ctrl+C during tool exec | Send SIGTERM, wait 5s, SIGKILL |

## New Architecture Components (Added in Refactoring)

### 10. Cache System (`src/cache/`)

Nova now includes a comprehensive caching system to improve performance and reduce API costs.

**Architecture:**
```
+----------------------------------------------------------+
|                    Cache System                           |
|   LLM Response Cache | Tool Result Cache | Context Cache |
|   (Memory-based, TTL) | (Memory-based, TTL) | (Memory-based, TTL) |
+----------------------------------------------------------+
|                    Cache Monitor                          |
|   Hit/Miss Tracking | Performance Metrics | Reporting    |
+----------------------------------------------------------+
```

**Components:**
- **LLM Response Cache:** Caches LLM API responses to avoid repeated calls
- **Tool Result Cache:** Caches tool execution results to avoid repeated executions
- **Context Cache:** Caches project context analysis results
- **Cache Monitor:** Tracks cache performance metrics

**Configuration:**
```typescript
interface CacheConfig {
  ttl: number; // Time to live in milliseconds
  maxSize: number; // Maximum number of entries
  strategy: 'lru' | 'lfu' | 'fifo'; // Eviction strategy
}
```

### 11. Enhanced Tool System (`src/tools/`)

Nova now supports enhanced tools with metadata and caching capabilities.

**Enhanced Tool Interface:**
```typescript
interface EnhancedTool {
  name: string;
  description: string;
  parameters: JSONSchema;
  metadata: ToolMetadata;
  execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
  executeWithCache(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
  requiresPermission?(params: Record<string, unknown>): boolean;
}

interface ToolMetadata {
  category: string;
  requiresContext: boolean;
  cacheable: boolean;
  timeout: number;
}
```

**Tool Execution Pipeline:**
```typescript
class ToolExecutionPipeline {
  private cache: ToolResultCache;
  private permissionChecker: PermissionPolicy;

  async execute(tool: EnhancedTool, params: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}
```

### 12. Planning System (`src/planning/`)

Nova now includes a planning system for task decomposition and execution.

**Components:**
- **Task Decomposer:** Breaks down user requests into subtasks using LLM
- **Planner:** Creates and executes plans based on task dependencies
- **Task Executor:** Executes individual tasks using the agent loop

**Task Interface:**
```typescript
interface Task {
  id: string;
  type: TaskType;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  dependencies: string[];
  estimatedTime: number;
  requiredTools: string[];
}
```

### 13. Subagent System (`src/subagent/`)

Nova now supports parallel execution through subagents.

**Components:**
- **SubAgent Interface:** Defines the contract for subagents
- **Default SubAgent:** Implementation using AgentLoop
- **SubAgent Pool:** Manages multiple subagents for parallel execution

**SubAgent Pool:**
```typescript
class SubAgentPool {
  private agents: SubAgent[] = [];
  private taskQueue: SubAgentTask[] = [];

  async executeTasks(tasks: SubAgentTask[]): Promise<SubAgentResult[]>;
}
```

### 14. Enhanced Network Search (`src/tools/`)

Nova now supports multiple search providers with caching.

**Search Providers:**
- **DuckDuckGo:** HTML scraping (no API key required)
- **Tavily:** API-based search (free tier available)

**Enhanced Features:**
- Multiple provider fallback
- Result caching
- Configurable result limits

## Future Extensions (Out of Scope for V1)

- Multi-turn conversation persistence (save/resume sessions)
- Image/file attachments in messages
- Multi-modal support (vision, audio)
- Agent-to-agent delegation (subagents)
- Conversation branching/forking
- Plugin system for custom tools (TypeScript plugins)
- Token usage tracking and cost estimation
- Theme customization
- Auto-update mechanism

## Success Criteria

1. `nova` starts an interactive TUI session
2. User can chat with LLM and receive streaming responses
3. LLM can read/write files, execute commands via tools
4. Dangerous commands trigger permission dialog
5. MCP servers can be configured and their tools are available
6. Skills can be installed from git repos and loaded into context
7. All tests pass
8. The agent can complete a real task end-to-end (e.g., "create a Node.js project with express")
9. **NEW:** Cache system improves performance with >70% hit rate
10. **NEW:** Planning system can decompose complex tasks into subtasks
11. **NEW:** Subagent system enables parallel task execution
12. **NEW:** Enhanced network search with multiple providers and caching
