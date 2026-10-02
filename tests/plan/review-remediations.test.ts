import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DirectoryInstructions } from '../../src/agent/directory-instructions.js';
import { FileHistory } from '../../src/agent/file-history.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { createReadFileTool } from '../../src/tools/read-file.js';
import { createWriteFileTool } from '../../src/tools/write-file.js';
import { createEditFileTool } from '../../src/tools/edit-file.js';

// PR #108 code-review remediations:
// 1) tool file-access is a REGISTRY capability (no hardcoded name lists)
// 2) the directory-instruction budget is a true hard cap (markers counted,
//    UTF-8 boundaries respected) and an exhausted budget stays silent
// 3) a failed restore skips (never throws, never consumes the entry)

describe('Tool.fileAccess registry capability', () => {
  it('read/write/edit tools declare their file-access kind', () => {
    expect(createReadFileTool().fileAccess).toBe('read');
    expect(createWriteFileTool().fileAccess).toBe('write');
    expect(createEditFileTool().fileAccess).toBe('write');
  });

  it('the registry answers "which tools touch files" without name lists', () => {
    const registry = new ToolRegistry();
    registry.register(createReadFileTool());
    registry.register(createWriteFileTool());
    registry.register(createEditFileTool());
    const touching = registry
      .getAll()
      .filter((t) => t.fileAccess === 'read' || t.fileAccess === 'write')
      .map((t) => t.name)
      .sort();
    expect(touching).toEqual(['edit_file', 'read_file', 'write_file']);
  });
});

describe('DirectoryInstructions hard budget (review fix)', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dirbudget-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('the crossing file INCLUDING its marker fits the remaining budget', () => {
    fs.mkdirSync(path.join(root, 'packages', 'core'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages', 'AGENTS.md'), 'B'.repeat(30 * 1024));
    fs.writeFileSync(path.join(root, 'packages', 'core', 'AGENTS.md'), 'C'.repeat(4 * 1024));
    const di = new DirectoryInstructions({ rootDir: root, maxTotalBytes: 32 * 1024 });
    const pending = di.pendingFor(path.join(root, 'packages', 'core', 'a.ts'));
    expect(pending).toHaveLength(2);
    let total = 0;
    for (const p of pending) total += Buffer.byteLength(p.content, 'utf-8');
    expect(total).toBeLessThanOrEqual(32 * 1024);
    expect(pending[1].content).toMatch(/\[truncated at \d+-byte budget\]$/);
  });

  it('truncation never splits a multi-byte character', () => {
    fs.mkdirSync(path.join(root, 'pkg'), { recursive: true });
    // 'あ' is 3 UTF-8 bytes; 4 KiB of them crosses any non-mod-3 boundary.
    fs.writeFileSync(path.join(root, 'pkg', 'AGENTS.md'), 'あ'.repeat(4096), 'utf-8');
    const di = new DirectoryInstructions({ rootDir: root, maxTotalBytes: 1000 });
    const pending = di.pendingFor(path.join(root, 'pkg', 'a.ts'));
    expect(pending).toHaveLength(1);
    expect(pending[0].content).not.toContain('\uFFFD');
    expect(Buffer.byteLength(pending[0].content, 'utf-8')).toBeLessThanOrEqual(1000);
  });

  it('an exhausted budget stays silent on later touches (no dropped-note spam)', () => {
    fs.mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a', 'AGENTS.md'), 'A'.repeat(2000));
    fs.writeFileSync(path.join(root, 'a', 'b', 'AGENTS.md'), 'B'.repeat(2000));
    fs.writeFileSync(path.join(root, 'a', 'b', 'c', 'AGENTS.md'), 'C'.repeat(2000));
    const di = new DirectoryInstructions({ rootDir: root, maxTotalBytes: 3000 });
    const first = di.pendingFor(path.join(root, 'a', 'b', 'c', 'x.ts'));
    expect(first.length).toBeGreaterThan(0);
    // New directories beyond the budget add NOTHING to the transcript.
    fs.mkdirSync(path.join(root, 'd'), { recursive: true });
    fs.writeFileSync(path.join(root, 'd', 'AGENTS.md'), 'D');
    expect(di.pendingFor(path.join(root, 'd', 'y.ts'))).toEqual([]);
  });
});

describe('FileHistory restore fault isolation (review fix)', () => {
  let root: string;
  let histDir: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fhfault-'));
    histDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fhfault-hist-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(histDir, { recursive: true, force: true });
  });

  it('a target blocked by a same-named directory is skipped; others restore', () => {
    const good = path.join(root, 'good.txt');
    const bad = path.join(root, 'bad.txt');
    fs.writeFileSync(good, 'G-NEW', 'utf-8');
    const fh = new FileHistory({ historyDir: histDir });
    fh.snapshotBefore(good);
    fh.snapshotBefore(bad); // file absent → existsBefore=false
    fs.writeFileSync(good, 'G-OLD-WOULD-BE-RESTORED', 'utf-8');
    fh.noteWritten(good);
    fh.noteWritten(bad);
    // Simulate a hostile filesystem: the restore target for bad.txt is now a
    // NON-EMPTY directory (unlink without recursive throws ENOTEMPTY, and a
    // copy onto it fails too — deterministic on every platform).
    fs.mkdirSync(bad);
    fs.writeFileSync(path.join(bad, 'occupant.txt'), 'x');

    let report!: ReturnType<FileHistory['restore']>;
    expect(() => {
      report = fh.restore([good, bad]);
    }).not.toThrow();
    expect(report.restored).toEqual([good]);
    expect(fs.readFileSync(good, 'utf-8')).toBe('G-NEW');
    expect(report.skipped).toEqual([path.resolve(bad)]);
    // The failing entry stays tracked (not consumed): a later retry can work.
    expect(fh.trackedPaths().has(path.resolve(bad))).toBe(true);
    expect(fs.existsSync(bad)).toBe(true);
  });
});
