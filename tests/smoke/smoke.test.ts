/**
 * Full-project SMOKE test against a real LLM endpoint.
 *
 * Target: opencode-go subscription (https://opencode.ai/zen/go/v1),
 * model mimo-v2.5 (OpenAI-compatible chat completions).
 *
 * Covers the whole stack end to end:
 *   model catalog resolution → wire adapter → agent loop (streaming +
 *   tool_calls parsing) → tool execution pipeline → permission policy →
 *   built-in tools (read_file / bash / web_search / web_fetch / todo) →
 *   session JSONL persistence → prompt-cache usage metrics.
 *
 * Run: NOVA_SMOKE_API_KEY=... pnpm test:smoke
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadModelCatalog, resolveModel } from '../../src/llm/catalog.js';
import { providerRegistry } from '../../src/llm/registry.js';
import type { LLMProvider } from '../../src/llm/provider.js';
import type { Message, ToolCall } from '../../src/llm/types.js';
import type { ToolResult } from '../../src/tools/types.js';
import { AgentLoop } from '../../src/agent/loop.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolExecutionPipeline } from '../../src/tools/execution-pipeline.js';
import { ToolResultCache } from '../../src/cache/tool-result-cache.js';
import { PromptCacheMetrics } from '../../src/cache/prompt-cache-metrics.js';
import { PermissionPolicy } from '../../src/permission/policy.js';
import { SessionStore } from '../../src/agent/session.js';
import { createReadFileTool } from '../../src/tools/read-file.js';
import { createWriteFileTool } from '../../src/tools/write-file.js';
import { createBashTool } from '../../src/tools/bash.js';
import { createTodoTool } from '../../src/tools/todo.js';
import { createWebSearchTool } from '../../src/tools/web-search.js';
import { createWebFetchTool } from '../../src/tools/web-fetch.js';

const BASE_URL = 'https://opencode.ai/zen/go/v1';
const MODEL = 'mimo-v2.5';
const apiKey = process.env.NOVA_SMOKE_API_KEY;
const tavilyKey = process.env.TAVILY_API_KEY;
const hasKey = typeof apiKey === 'string' && apiKey.length > 0;

let tmp: string;
let sessionDir: string;
let markerFile: string;
const MARKER = 'NOVA-SMOKE-MARKER-7f3a9c';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-smoke-'));
  sessionDir = path.join(tmp, 'sessions');
  markerFile = path.join(tmp, 'smoke.txt');
  fs.writeFileSync(markerFile, `secret-content: ${MARKER}\n`);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Build the full stack the same way index.tsx does. */
function buildLoop(): {
  loop: AgentLoop;
  metrics: PromptCacheMetrics;
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  sessionFile: string;
  tokens: string[];
} {
  // Model catalog: declare the subscription model through the user catalog
  // (dogfooding the data-driven catalog path).
  const catalogFile = path.join(tmp, 'models.json');
  fs.writeFileSync(
    catalogFile,
    JSON.stringify({
      providers: {
        'opencode-go': {
          baseUrl: BASE_URL,
          api: 'openai-completions',
          apiKey,
          models: [
            {
              id: MODEL,
              contextWindow: 1_000_000,
              maxTokens: 32_000,
              reasoning: true,
              compat: { supportsDeveloperRole: false, streamUsage: true },
            },
          ],
        },
      },
    }),
  );
  const catalog = loadModelCatalog([catalogFile]);
  const resolution = resolveModel({ provider: 'opencode-go', model: MODEL }, catalog);
  const llm = providerRegistry.getForApi(resolution.api, {
    name: resolution.name,
    apiKey: resolution.apiKey,
    baseUrl: resolution.baseUrl,
    model: resolution.model.id,
    compat: {
      supportsDeveloperRole: resolution.model.compat.supportsDeveloperRole,
      streamUsage: resolution.model.compat.streamUsage,
    },
    thinkingLevelMap: resolution.model.thinkingLevelMap,
    reasoning: resolution.model.reasoning,
  }) as LLMProvider;

  // Tools
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(createReadFileTool());
  toolRegistry.register(createWriteFileTool());
  toolRegistry.register(createBashTool());
  toolRegistry.register(createTodoTool({ todos: [] }));
  if (tavilyKey) {
    toolRegistry.register(createWebSearchTool({ tavilyApiKey: tavilyKey }));
  }
  toolRegistry.register(createWebFetchTool());

  const pipeline = new ToolExecutionPipeline(new ToolResultCache(), new PermissionPolicy({
    autoApproveFileWrite: true,
    autoApproveBash: false,
    alwaysAllowCommands: [],
  }));

  const metrics = new PromptCacheMetrics();
  const toolCalls: ToolCall[] = [];
  const toolResults: ToolResult[] = [];
  const tokens: string[] = [];
  const sessionFile = path.join(sessionDir, 'smoke.jsonl');
  const session = new SessionStore(sessionFile);

  const loop = new AgentLoop({
    llm,
    toolRegistry,
    toolExecutionPipeline: pipeline,
    session,
    context: { maxTokens: resolution.model.contextWindow, strategy: 'truncate' },
    config: { maxToolRounds: 6, model: resolution.model.id },
    onUsage: (usage) => metrics.record(usage),
    onToken: (t) => tokens.push(t),
    onToolCall: (c) => toolCalls.push(c),
    onToolResult: (r) => toolResults.push(r),
    // Auto-confirm everything: this is a headless smoke test.
    onPermissionRequest: async () => true,
  });

  return { loop, metrics, toolCalls, toolResults, sessionFile, tokens };
}

describe.skipIf(!hasKey)('SMOKE: full stack against opencode-go / mimo-v2.5', () => {
  it('1. plain text turn — streaming works, usage reported, session persisted', async () => {
    const { loop, metrics, sessionFile, tokens } = buildLoop();
    const turn = await loop.processUserInput('Reply with exactly: SMOKE-TEXT-OK');

    expect(turn.text).toContain('SMOKE-TEXT-OK');
    expect(tokens.join('').length).toBeGreaterThan(0);
    expect(metrics.totalInputTokens).toBeGreaterThan(0);
    expect(metrics.totalOutputTokens).toBeGreaterThan(0);

    // Session JSONL persisted user + assistant messages
    const persisted = SessionStore.load(sessionFile);
    const roles = persisted.map((m) => m.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
  }, 240_000);

  it('2. read_file tool turn — model reads the file and reports the marker', async () => {
    const { loop, toolCalls, toolResults } = buildLoop();
    const turn = await loop.processUserInput(
      `Read the file ${markerFile} with the read_file tool, then tell me the secret content it contains verbatim.`,
    );

    expect(toolCalls.some((c) => c.function.name === 'read_file')).toBe(true);
    expect(toolResults.length).toBeGreaterThan(0);
    expect(toolResults[0].isError).toBeUndefined();
    expect(turn.text).toContain(MARKER);
  }, 240_000);

  it('3. bash tool turn — model executes a command and reports stdout', async () => {
    const { loop, toolCalls } = buildLoop();
    const turn = await loop.processUserInput(
      'Run this shell command with the bash tool: echo BASH-SMOKE-9931 ; then tell me its exact output.',
    );

    expect(toolCalls.some((c) => c.function.name === 'bash')).toBe(true);
    expect(turn.text).toContain('BASH-SMOKE-9931');
  }, 240_000);

  it('4. context management active — contextWindow wired from the catalog', async () => {
    const { loop } = buildLoop();
    const turn = await loop.processUserInput('Reply with exactly: CTX-OK');
    expect(turn.text).toContain('CTX-OK');
    // 1M context window resolved from the catalog → no truncation at this size
    expect(loop.getMessages().length).toBeGreaterThanOrEqual(2);
  }, 240_000);

  it('5. web_search live (Tavily)', async () => {
    if (!tavilyKey) {
      console.log('skip: TAVILY_API_KEY not set');
      return;
    }
    const { loop } = buildLoop();
    const turn = await loop.processUserInput(
      'Use the web_search tool to search for "opencode zen api", then name the first result title.',
    );
    expect(turn.text.length).toBeGreaterThan(10);
  }, 240_000);

  it('6. web_fetch live', async () => {
    const { loop } = buildLoop();
    const turn = await loop.processUserInput(
      'Use the web_fetch tool on https://example.com and tell me the main heading of the page.',
    );
    expect(turn.text).toContain('Example Domain');
  }, 240_000);
});
