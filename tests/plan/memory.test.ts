import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readMemory, appendMemory, createMemoryTool } from '../../src/memory/store.js';
import { buildSystemPrompt } from '../../src/agent/prompt.js';

describe('Memory store', () => {
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
    fs.writeFileSync(corrupt, Buffer.from([[0xff, 0xfe, 0x00, 0x01]], 'utf-8') as unknown as string);
    expect(typeof readMemory(corrupt)).toBe('string');
  });

  it('appendMemory creates directories and appends with a timestamp', () => {
    const file = path.join(dir, 'nested', 'MEMORY.md');
    appendMemory(file, 'user prefers pnpm');
    appendMemory(file, 'tests live in tests/plan');
    const content = readMemory(file);
    expect(content).toMatch(/- \[\d{4}-\d{2}-\d{2}\] user prefers pnpm/);
    expect(content).toContain('tests live in tests/plan');
    expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}\]/); // date-stamped
  });

  it('memory_write tool appends facts and reports success', async () => {
    const file = path.join(dir, 'MEMORY.md');
    const tool = createMemoryTool(file);
    const result = await tool.execute({ fact: 'deploys via GitHub Actions' }, { workingDirectory: dir } as never);
    expect(result.isError ?? false).toBe(false);
    expect(readMemory(file)).toContain('deploys via GitHub Actions');
  });

  it('memory_write tool rejects empty facts', async () => {
    const tool = createMemoryTool(path.join(dir, 'MEMORY.md'));
    const result = await tool.execute({ fact: '   ' }, { workingDirectory: dir } as never);
    expect(result.isError).toBe(true);
  });

  it('memory section is injected into the frozen system prompt', () => {
    const prompt = buildSystemPrompt([], [], {
      memory: '- user prefers pnpm\n- tests live in tests/plan',
    });
    expect(prompt).toContain('## Memory');
    expect(prompt).toContain('user prefers pnpm');
    // Without memory, no empty section
    const bare = buildSystemPrompt([], [], {});
    expect(bare).not.toContain('## Memory');
  });
});
