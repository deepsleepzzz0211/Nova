import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readMemory,
  appendMemory,
  formatMemoryIndex,
  upsertMemoryTopic,
  buildMemorySection,
  createMemoryTool,
} from '../../src/memory/store.js';
import { buildSystemPrompt } from '../../src/agent/prompt.js';

// memory-v2 ticket 01: learned memory becomes one-fact-per-topic-file with a
// MEMORY.md index (Claude Code / ZCode shape). The index is what gets injected
// into the frozen system prompt, capped at 200 lines / 25KB with an explicit
// truncation warning; legacy plain-bullet MEMORY.md files must still load.

describe('Memory store (legacy readers kept)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-memory-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('readMemory returns empty string for missing/corrupt files', () => {
    expect(readMemory(path.join(dir, 'missing.md'))).toBe('');
    const corrupt = path.join(dir, 'corrupt.md');
    fs.writeFileSync(corrupt, Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    expect(typeof readMemory(corrupt)).toBe('string');
  });

  it('appendMemory creates directories and appends with a timestamp', () => {
    const file = path.join(dir, 'nested', 'MEMORY.md');
    appendMemory(file, 'user prefers pnpm');
    const content = readMemory(file);
    expect(content).toMatch(/- \[\d{4}-\d{2}-\d{2}\] user prefers pnpm/);
  });

  it('readMemory degrades to empty string on unreadable paths (EISDIR)', () => {
    expect(readMemory(dir)).toBe('');
  });
});

describe('formatMemoryIndex (cap + warning)', () => {
  it('short indexes pass through untouched (trimming only)', () => {
    expect(formatMemoryIndex('- [a](a.md) — hook\n\n')).toBe('- [a](a.md) — hook');
  });

  it('strips leading YAML frontmatter (legacy files may carry one)', () => {
    expect(formatMemoryIndex('---\ntags: x\n---\n- keep me')).toBe('- keep me');
  });

  it('caps at 200 lines and warns that only part loaded', () => {
    const lines = Array.from({ length: 250 }, (_, i) => `- [t${i}](t${i}.md) — hook`);
    const out = formatMemoryIndex(lines.join('\n'));
    const loaded = out.split('\n').filter((l) => l.startsWith('- [t'));
    expect(loaded).toHaveLength(200);
    expect(out).toMatch(/WARNING/i);
    expect(out).toMatch(/250 lines \(limit: 200\)/);
    expect(out).toMatch(/move detail into topic files/i);
  });

  it('caps at 25KB cutting on a line boundary', () => {
    const big = Array.from({ length: 40 }, () => `- [x](x.md) — ${'y'.repeat(700)}`).join('\n');
    expect(big.length).toBeGreaterThan(25_000);
    const out = formatMemoryIndex(big);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toMatch(/WARNING/i);
    expect(out).toMatch(/index entries are too long/);
  });

  it('empty content yields empty string', () => {
    expect(formatMemoryIndex('   ')).toBe('');
  });
});

describe('upsertMemoryTopic (one fact, one file, one index line)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-mem-topic-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a frontmatter topic file and appends the index line', () => {
    upsertMemoryTopic(dir, {
      name: 'pnpm-only',
      description: 'dependencies install with pnpm, never npm',
      type: 'feedback',
      body: 'Use pnpm.\n\n**Why:** lockfile drift burned the last quarter.\n**How to apply:** run pnpm install for any dependency change.',
    });
    const topic = fs.readFileSync(path.join(dir, 'pnpm-only.md'), 'utf-8');
    expect(topic.startsWith('---\n')).toBe(true);
    expect(topic).toContain('name: pnpm-only');
    expect(topic).toContain('description: dependencies install with pnpm, never npm');
    expect(topic).toContain('  type: feedback');
    expect(topic).toContain('**Why:**');
    const index = readMemory(path.join(dir, 'MEMORY.md'));
    expect(index).toBe('- [pnpm-only](pnpm-only.md) — dependencies install with pnpm, never npm');
  });

  it('sanitizes messy names to a kebab-case slug', () => {
    upsertMemoryTopic(dir, { name: 'My  Rule #1!', description: 'd', type: 'project', body: 'b' });
    expect(fs.existsSync(path.join(dir, 'my-rule-1.md'))).toBe(true);
  });

  it('re-upsert replaces the topic body and updates the index line IN PLACE (no duplicates)', () => {
    upsertMemoryTopic(dir, { name: 'release-flow', description: 'v1 hook', type: 'project', body: 'first' });
    upsertMemoryTopic(dir, { name: 'release-flow', description: 'v2 hook', type: 'project', body: 'second' });
    const topic = fs.readFileSync(path.join(dir, 'release-flow.md'), 'utf-8');
    expect(topic).toContain('second');
    expect(topic).not.toContain('first');
    expect(topic).toContain('description: v2 hook');
    const indexLines = readMemory(path.join(dir, 'MEMORY.md')).split('\n');
    expect(indexLines.filter((l) => l.includes('release-flow.md'))).toHaveLength(1);
    expect(indexLines[0]).toContain('v2 hook');
  });

  it('keeps legacy plain bullets in MEMORY.md and adds below them', () => {
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), '- [2026-10-01] old-style fact\n');
    upsertMemoryTopic(dir, { name: 'new', description: 'd', type: 'reference', body: 'b' });
    const index = readMemory(path.join(dir, 'MEMORY.md'));
    expect(index).toContain('old-style fact');
    expect(index).toContain('- [new](new.md) — d');
  });

  it('rejects empty names or bodies (caller sees the constraint)', () => {
    expect(() =>
      upsertMemoryTopic(dir, { name: ' /// ', description: 'd', type: 'project', body: 'b' }),
    ).toThrow();
    expect(() =>
      upsertMemoryTopic(dir, { name: 'ok', description: 'd', type: 'project', body: '  ' }),
    ).toThrow();
  });
});

describe('buildMemorySection (what the frozen prompt shows)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-mem-sec-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('no memories anywhere yields an empty section (prompt stays lean)', () => {
    expect(buildMemorySection([path.join(dir, 'a'), path.join(dir, 'b')])).toBe('');
  });

  it('composes per-tree blocks with the directory paths and capped indexes', () => {
    const userTree = path.join(dir, 'user');
    const projTree = path.join(dir, 'proj');
    fs.mkdirSync(projTree);
    upsertMemoryTopic(userTree, { name: 'prefers-pnpm', description: 'pnpm only', type: 'feedback', body: 'b' });
    fs.writeFileSync(path.join(projTree, 'MEMORY.md'), '- legacy bullet fact\n');
    const section = buildMemorySection([userTree, projTree]);
    expect(section).toContain(userTree);
    expect(section).toContain('- [prefers-pnpm](prefers-pnpm.md) — pnpm only');
    expect(section).toContain('- legacy bullet fact');
    // The section points at topic files so the model knows where the bodies live.
    expect(section).toMatch(/topic files/i);
  });

  it('index cap applies inside the section too', () => {
    const tree = fs.mkdtempSync(path.join(dir, 'big-'));
    fs.writeFileSync(
      path.join(tree, 'MEMORY.md'),
      Array.from({ length: 300 }, (_, i) => `- [t${i}](t${i}.md) — h`).join('\n'),
    );
    const section = buildMemorySection([tree]);
    expect(section).toMatch(/WARNING/i);
  });

  it('keeps the given tree order (user block before project block — cache-stable injection)', () => {
    const userTree = fs.mkdirSync(path.join(dir, 'u'), { recursive: true }) || path.join(dir, 'u');
    const projTree = fs.mkdirSync(path.join(dir, 'p'), { recursive: true }) || path.join(dir, 'p');
    upsertMemoryTopic(userTree, { name: 'u-hook', description: 'UUHOOK', type: 'feedback', body: 'b' });
    upsertMemoryTopic(projTree, { name: 'p-hook', description: 'PPHOOK', type: 'project', body: 'b' });
    const section = buildMemorySection([userTree, projTree]);
    expect(section.indexOf('UUHOOK')).toBeLessThan(section.indexOf('PPHOOK'));
  });
});

describe('memory_write tool (scope routing, ticket 02)', () => {
  let userTree: string;
  let projTree: string;
  beforeEach(() => {
    userTree = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-mem-user-'));
    projTree = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-mem-proj-'));
  });
  afterEach(() => {
    fs.rmSync(userTree, { recursive: true, force: true });
    fs.rmSync(projTree, { recursive: true, force: true });
  });

  const trees = () => ({ user: userTree, project: projTree });
  const ctx = (): never => ({ workingDirectory: projTree } as never);

  it('scope=project writes the topic file + index in the project tree only', async () => {
    const tool = createMemoryTool(trees());
    const r = await tool.execute(
      { name: 'deploys-via-gha', description: 'deploys run on GitHub Actions', type: 'project', scope: 'project', fact: 'CI does the deploy; never deploy from laptops.' },
      ctx(),
    );
    expect(r.isError ?? false).toBe(false);
    expect(r.content).toContain('deploys-via-gha.md');
    expect(fs.existsSync(path.join(projTree, 'deploys-via-gha.md'))).toBe(true);
    expect(readMemory(path.join(projTree, 'MEMORY.md'))).toContain('deploys run on GitHub Actions');
    expect(fs.existsSync(path.join(userTree, 'deploys-via-gha.md'))).toBe(false);
    expect(fs.existsSync(path.join(userTree, 'MEMORY.md'))).toBe(false);
  });

  it('scope=user writes the user tree only — indexes stay unpolluted across trees', async () => {
    const tool = createMemoryTool(trees());
    const r = await tool.execute(
      { name: 'pnpm-only', description: 'user prefers pnpm over npm', type: 'feedback', scope: 'user', fact: 'Never suggest npm install.' },
      ctx(),
    );
    expect(r.isError ?? false).toBe(false);
    expect(fs.existsSync(path.join(userTree, 'pnpm-only.md'))).toBe(true);
    expect(readMemory(path.join(userTree, 'MEMORY.md'))).toContain('user prefers pnpm');
    expect(fs.existsSync(path.join(projTree, 'pnpm-only.md'))).toBe(false);
    expect(fs.existsSync(path.join(projTree, 'MEMORY.md'))).toBe(false);
  });

  it('missing scope defaults to project (current behavior preserved)', async () => {
    const tool = createMemoryTool(trees());
    const r = await tool.execute(
      { name: 'tests-here', description: 'tests live in tests/plan', type: 'project', fact: 'b' },
      ctx(),
    );
    expect(r.isError ?? false).toBe(false);
    expect(fs.existsSync(path.join(projTree, 'tests-here.md'))).toBe(true);
    expect(fs.existsSync(path.join(userTree, 'tests-here.md'))).toBe(false);
  });

  it('an unknown scope is rejected, not silently routed', async () => {
    const tool = createMemoryTool(trees());
    const r = await tool.execute(
      { name: 'x', description: 'd', type: 'project', scope: 'team', fact: 'b' },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(fs.readdirSync(projTree)).toEqual([]);
    expect(fs.readdirSync(userTree)).toEqual([]);
  });

  it('rejects empty facts and unknown types', async () => {
    const tool = createMemoryTool(trees());
    expect((await tool.execute({ name: 'a', description: 'd', type: 'project', fact: '  ' }, ctx())).isError).toBe(true);
    expect((await tool.execute({ name: 'a', description: 'd', type: 'vibes', fact: 'x' }, ctx())).isError).toBe(true);
    expect((await tool.execute({ name: '  ', description: 'd', type: 'user', fact: 'x' }, ctx())).isError).toBe(true);
  });

  it('description carries the write discipline AND the scope-routing examples', () => {
    const tool = createMemoryTool(trees());
    expect(tool.description).toMatch(/update/i);
    expect(tool.description).toMatch(/already/i);
    expect(tool.description).toMatch(/one fact/i);
    // Routing taught to the model: personal/environment → user, conventions → project, default project.
    expect(tool.description).toMatch(/personal/i);
    expect(tool.description).toMatch(/team/i);
    expect(tool.description).toMatch(/default/i);
  });
});

describe('full chain (frozen prompt injection)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-mem-chain-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('topics in two trees reach the system prompt as capped indexes', () => {
    const userTree = path.join(dir, 'user');
    const projTree = path.join(dir, 'project');
    upsertMemoryTopic(userTree, { name: 'pnpm', description: 'user prefers pnpm', type: 'feedback', body: 'b' });
    upsertMemoryTopic(projTree, { name: 'tests', description: 'tests live in tests/plan', type: 'project', body: 'b' });
    const memory = buildMemorySection([userTree, projTree]);
    const prompt = buildSystemPrompt([], [], { memory });
    expect(prompt).toContain('## Memory');
    expect(prompt).toContain('user prefers pnpm');
    expect(prompt).toContain('tests live in tests/plan');
  });

  it('memory section is omitted when empty; present without trailing blank header otherwise', () => {
    const bare = buildSystemPrompt([], [], {});
    expect(bare).not.toContain('## Memory');
  });
});
