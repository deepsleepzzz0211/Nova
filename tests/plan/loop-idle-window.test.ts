import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentLoop, type LoopContextConfig } from '../../src/agent/loop.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolExecutionPipeline } from '../../src/tools/execution-pipeline.js';
import { ToolResultCache } from '../../src/cache/tool-result-cache.js';
import { PermissionPolicy } from '../../src/permission/policy.js';
import { SessionStore } from '../../src/agent/session.js';
import { MICROCOMPACT_MARKER } from '../../src/agent/microcompact.js';
import type { ChatOptions, Message, StreamChunk } from '../../src/llm/types.js';
import type { LLMProvider } from '../../src/llm/provider.js';
import type { Tool } from '../../src/tools/types.js';

// survived-hunt (test-effectiveness 03), cluster: AgentLoop context-management
// region. Targets the mutants the Sep-24 report left alive: the default
// 60-minute idle arithmetic, the idle/pressure gate, and the persist/event
// side effects of a microcompact pass.

const policy = new PermissionPolicy({
  autoApproveFileWrite: false, autoApproveBash: false, alwaysAllowCommands: [],
});

function mockLLM(): LLMProvider {
  return {
    name: 'fake',
    capabilities: { streaming: true, toolCalling: true, vision: false, maxContextLength: 128_000, models: ['fake'] },
    async *chat(): AsyncIterable<StreamChunk> {
      yield { type: 'text_delta', content: 'ok' };
    },
  };
}

function readTool(): Tool {
  return {
    name: 'read_file', description: 'Read',
    permission: { mode: 'auto' as const },
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: 'x' }),
  };
}

function bigBody(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `filler ${i}: plain english sentence body`).join('\n');
}

function group(toolName: string, id: string, body: string): Message[] {
  return [
    {
      role: 'assistant', content: '',
      tool_calls: [{ id, type: 'function', function: { name: toolName, arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: id, content: body },
  ];
}

function seedGroups(count: number, lines: number): Message[] {
  const out: Message[] = [{ role: 'user', content: 'start' }];
  for (let i = 0; i < count; i++) out.push(...group('read_file', `s${i}`, bigBody(lines)));
  return out;
}

interface Captured { strategy: string; reason: string; before: number; after: number }

function makeLoop(
  contextConfig: LoopContextConfig,
  session?: SessionStore,
): { loop: AgentLoop; events: Captured[] } {
  const registry = new ToolRegistry();
  registry.register(readTool());
  const events: Captured[] = [];
  const loop = new AgentLoop({
    llm: mockLLM(),
    toolRegistry: registry,
    toolExecutionPipeline: new ToolExecutionPipeline(new ToolResultCache(), policy),
    config: { maxToolRounds: 5, model: 'test' },
    ...(session ? { session } : {}),
    context: contextConfig,
    onCompaction: (i) => events.push({ strategy: i.strategy, reason: i.reason ?? '', before: i.beforeTokens, after: i.afterTokens }),
    onToken: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onPermissionRequest: async () => true,
  });
  return { loop, events };
}

function clearedCount(loop: AgentLoop): number {
  return loop.getMessages().filter(
    (m) => m.role === 'tool' && (m.content ?? '').startsWith(MICROCOMPACT_MARKER),
  ).length;
}

const WIDE = { maxTokens: 100_000, reserveTokens: 1000, strategy: 'truncate' } as const;

describe('microcompact default idle window (survived hunt: loop.ts 168-274)', () => {
  it('59 minutes of idle must NOT clear; 61 minutes after activity MUST', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-24T12:00:00Z'));
      const { loop, events } = makeLoop({ ...WIDE }); // no microcompactIdleMs → default
      loop.loadMessages(seedGroups(7, 60));
      // 59 min idle: below the default 60-min window, no token pressure.
      vi.setSystemTime(new Date('2026-09-24T12:59:00Z'));
      await loop.processUserInput('continue');
      expect(clearedCount(loop)).toBe(0);
      expect(events.filter((e) => e.strategy === 'microcompact')).toHaveLength(0);
      // 61 min after the LAST activity (the turn above).
      vi.setSystemTime(new Date('2026-09-24T14:00:00Z'));
      await loop.processUserInput('and now');
      expect(clearedCount(loop)).toBeGreaterThanOrEqual(1);
      const micro = events.find((e) => e.strategy === 'microcompact');
      expect(micro).toBeDefined();
      expect(micro!.reason).toBe('idle');
      expect(micro!.after).toBeLessThan(micro!.before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an idle microcompact pass persists a compaction checkpoint', async () => {
    vi.useFakeTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-idle-'));
    try {
      vi.setSystemTime(new Date('2026-09-24T12:00:00Z'));
      const sessionFile = path.join(dir, 's.jsonl');
      const session = new SessionStore(sessionFile);
      const { loop } = makeLoop({ ...WIDE, microcompactIdleMs: 1000 }, session);
      loop.loadMessages(seedGroups(7, 60));
      vi.setSystemTime(new Date('2026-09-24T12:00:05Z'));
      await loop.processUserInput('continue');
      await session.close();
      const jsonl = fs.readFileSync(sessionFile, 'utf-8');
      expect(jsonl).toContain('"type":"compaction"');
    } finally {
      vi.useRealTimers();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
