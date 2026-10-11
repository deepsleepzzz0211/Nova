import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'path';
import type { LLMProvider } from '../../src/llm/provider.js';
import type { ChatOptions, Message, StreamChunk } from '../../src/llm/types.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ToolExecutionPipeline } from '../../src/tools/execution-pipeline.js';
import { ToolResultCache } from '../../src/cache/tool-result-cache.js';
import { PermissionPolicy } from '../../src/permission/policy.js';
import {
  createMemoryAgentRegistry,
  createMemoryExtractor,
} from '../../src/memory/extraction-agent.js';
import { upsertMemoryTopic, type MemoryTrees } from '../../src/memory/store.js';
import type { ExtractionSnapshot } from '../../src/memory/extraction-scheduler.js';

/**
 * memory-v2 ticket 05: the REAL extraction executor that replaces ticket 04's
 * stub. A dedicated memory subagent (≤5 rounds) sees ONLY the snapshot
 * window, may ONLY touch the memory trees (confined read_file/grep/glob +
 * scope-routed memory_write), and its failures must never surface as more
 * than one visible stderr warning.
 */

const policy = new PermissionPolicy({
  autoApproveFileWrite: false,
  autoApproveBash: false,
  alwaysAllowCommands: [],
});

function makePipeline(): ToolExecutionPipeline {
  return new ToolExecutionPipeline(new ToolResultCache(), policy);
}

/** Scripted provider: one script (chunks per call) per index. */
function scriptedLLM(scripts: ((call: number, msgs: Message[]) => StreamChunk[])[]): {
  llm: LLMProvider;
  chats: Message[][];
} {
  const chats: Message[][] = [];
  const llm: LLMProvider = {
    name: 'faux',
    capabilities: { streaming: true, toolCalling: true, vision: false, maxContextLength: 128_000, models: ['faux'] },
    async *chat(msgs: Message[], _opts: ChatOptions): AsyncIterable<StreamChunk> {
      const call = chats.length;
      chats.push(msgs.map((m) => ({ ...m })));
      const script = scripts[Math.min(call, scripts.length - 1)];
      yield* script(call, msgs);
    },
  };
  return { llm, chats };
}

function toolCall(id: string, name: string, args: Record<string, unknown>): StreamChunk[] {
  return [
    { type: 'tool_call_start', id, name },
    { type: 'tool_call_delta', id, arguments: JSON.stringify(args) },
    { type: 'tool_call_end', id },
  ];
}

const ctx = (workingDirectory: string): never =>
  ({ workingDirectory, abortSignal: new AbortController().signal } as never);

describe('memory agent tool registry (confinement)', () => {
  let trees: MemoryTrees;
  beforeEach(() => {
    trees = {
      user: fs.mkdtempSync(path.join(os.tmpdir(), 'nova-memagent-user-')),
      project: fs.mkdtempSync(path.join(os.tmpdir(), 'nova-memagent-proj-')),
    };
  });
  afterEach(() => {
    fs.rmSync(trees.user, { recursive: true, force: true });
    fs.rmSync(trees.project, { recursive: true, force: true });
  });

  it('exposes exactly the four confined tools', () => {
    const names = createMemoryAgentRegistry(trees).getAll().map((t) => t.name).sort();
    expect(names).toEqual(['glob', 'grep', 'memory_write', 'read_file']);
  });

  it('read_file outside the memory trees is denied without touching the fs', async () => {
    const registry = createMemoryAgentRegistry(trees);
    const tool = registry.getAll().find((t) => t.name === 'read_file')!;
    const secret = path.join(os.tmpdir(), 'not-memory-secret.txt');
    fs.writeFileSync(secret, 'TOP SECRET OUTSIDE', 'utf-8');
    try {
      const r = await tool.execute({ path: secret }, ctx(process.cwd()));
      expect(r.isError).toBe(true);
      expect(r.content).not.toContain('TOP SECRET');
      expect(r.content).toMatch(/memory/i);
    } finally {
      fs.rmSync(secret, { force: true });
    }
  });

  it('read_file inside a tree works; grep/glob without an explicit in-tree path are denied', async () => {
    const registry = createMemoryAgentRegistry(trees);
    upsertMemoryTopic(trees.user, { name: 'quirk', description: 'host detail', type: 'project', body: 'BODY LINE 42' });
    const readFile = registry.getAll().find((t) => t.name === 'read_file')!;
    const ok = await readFile.execute({ path: path.join(trees.user, 'quirk.md') }, ctx(process.cwd()));
    expect(ok.content).toContain('BODY LINE 42');

    const grep = registry.getAll().find((t) => t.name === 'grep')!;
    expect((await grep.execute({ pattern: 'BODY' }, ctx(process.cwd()))).isError).toBe(true);
    const inTree = await grep.execute({ pattern: 'BODY', path: trees.user }, ctx(process.cwd()));
    expect(inTree.isError ?? false).toBe(false);
    expect(inTree.content).toContain('quirk.md');

    const glob = registry.getAll().find((t) => t.name === 'glob')!;
    expect((await glob.execute({ pattern: '*.md' }, ctx(process.cwd()))).isError).toBe(true);
  });
});

describe('memory extractor (task, outcomes, isolation)', () => {
  let trees: MemoryTrees;
  beforeEach(() => {
    trees = {
      user: fs.mkdtempSync(path.join(os.tmpdir(), 'nova-memx-user-')),
      project: fs.mkdtempSync(path.join(os.tmpdir(), 'nova-memx-proj-')),
    };
  });
  afterEach(() => {
    fs.rmSync(trees.user, { recursive: true, force: true });
    fs.rmSync(trees.project, { recursive: true, force: true });
  });

  function snapshot(messages: Message[]): ExtractionSnapshot {
    return { messages, memoryDirs: [trees.user, trees.project], workingDirectory: process.cwd() };
  }

  it('task carries ONLY the window, the tree paths, the existing indexes, and the discipline', async () => {
    upsertMemoryTopic(trees.project, { name: 'old-rule', description: 'EXISTING-HOOK line', type: 'project', body: 'b' });
    const { llm, chats } = scriptedLLM([() => [{ type: 'text_delta', content: 'Nothing to save.' } as StreamChunk]]);
    const extractor = createMemoryExtractor({
      llm, model: 'faux', toolExecutionPipeline: makePipeline(), trees,
    });
    const window: Message[] = [
      { role: 'user', content: 'WINDOW-ONLY-DETAIL: we ship via actions only now please' },
      { role: 'assistant', content: 'understood' },
    ];
    await extractor(snapshot([{ role: 'user', content: 'OLD-MATERIAL must not travel' }, ...window]), window);
    expect(chats).toHaveLength(1);
    const task = chats[0]
      .filter((m) => m.role === 'user')
      .map((m) => (m as { content: string }).content)
      .join('\n');
    expect(task).toContain('WINDOW-ONLY-DETAIL');
    expect(task).not.toContain('OLD-MATERIAL');
    expect(task).toContain(trees.user);
    expect(task).toContain(trees.project);
    expect(task).toContain('EXISTING-HOOK');
    expect(task).toMatch(/Nothing to save/i);
    expect(task).toMatch(/parallel/i); // turn-1 reads / turn-2 writes discipline
    expect(task).toMatch(/EMPTY/i); // an unreadable/missing MEMORY.md means an empty tree, not "save nothing"
  });

  it('scripted round: memory_write lands topic + index in the routed tree; status success', async () => {
    const { llm } = scriptedLLM([
      () => toolCall('w1', 'memory_write', { name: 'deploys', description: 'deploys via GHA', type: 'project', scope: 'project', fact: 'CI deploys only.' }),
      () => [{ type: 'text_delta', content: 'Memory updated.' } as StreamChunk],
    ]);
    const extractor = createMemoryExtractor({ llm, model: 'faux', toolExecutionPipeline: makePipeline(), trees });
    const window: Message[] = [
      { role: 'user', content: 'remember that deploys only run through GitHub Actions from now on' },
    ];
    const status = await extractor(snapshot(window), window);
    expect(status).toBe('success');
    expect(fs.existsSync(path.join(trees.project, 'deploys.md'))).toBe(true);
    expect(fs.readFileSync(path.join(trees.project, 'MEMORY.md'), 'utf-8')).toContain('deploys via GHA');
  });

  it('duplicate fact UPDATEs the existing topic (index stays single-line, file rewritten)', async () => {
    upsertMemoryTopic(trees.project, { name: 'pkg-manager', description: 'OLD hook', type: 'project', body: 'old body' });
    const { llm } = scriptedLLM([
      () => toolCall('w1', 'memory_write', { name: 'pkg-manager', description: 'NEW hook', type: 'project', scope: 'project', fact: 'pnpm only, npm is banned.' }),
      () => [{ type: 'text_delta', content: 'Updated the existing memory.' } as StreamChunk],
    ]);
    const extractor = createMemoryExtractor({ llm, model: 'faux', toolExecutionPipeline: makePipeline(), trees });
    const window: Message[] = [{ role: 'user', content: 'we switched package managers completely' }];
    const status = await extractor(snapshot(window), window);
    expect(status).toBe('success');
    const index = fs.readFileSync(path.join(trees.project, 'MEMORY.md'), 'utf-8');
    expect(index).toContain('NEW hook');
    expect(index).not.toContain('OLD hook');
    expect(index.split('\n').filter((l) => l.includes('](pkg-manager.md)'))).toHaveLength(1);
    expect(fs.readFileSync(path.join(trees.project, 'pkg-manager.md'), 'utf-8')).toContain('pnpm only');
  });

  it('"Nothing to save." is a no-op (cursor-advancing, nothing written)', async () => {
    const { llm } = scriptedLLM([() => [{ type: 'text_delta', content: 'Nothing to save.' } as StreamChunk]]);
    const extractor = createMemoryExtractor({ llm, model: 'faux', toolExecutionPipeline: makePipeline(), trees });
    const window: Message[] = [{ role: 'user', content: 'just a casual question about nothing' }];
    expect(await extractor(snapshot(window), window)).toBe('no-op');
    expect(fs.readdirSync(trees.project)).toEqual([]);
  });

  it('provider failure: one visible stderr warning, status error, NEVER throws upward', async () => {
    const warns: string[] = [];
    const failing: LLMProvider = {
      name: 'faux',
      capabilities: { streaming: true, toolCalling: true, vision: false, maxContextLength: 128_000, models: ['faux'] },
      async *chat(): AsyncIterable<StreamChunk> {
        throw new Error('stream exploded');
      },
    };
    const extractor = createMemoryExtractor({
      llm: failing, model: 'faux', toolExecutionPipeline: makePipeline(), trees,
      onWarn: (m) => warns.push(m),
    });
    const window: Message[] = [{ role: 'user', content: 'some meaningful user sentence here' }];
    const status = await extractor(snapshot(window), window);
    expect(status).toBe('error');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('[memory]');
    expect(fs.readdirSync(trees.project)).toEqual([]);
  });
});
