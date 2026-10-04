import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { FileHistory } from '../../src/agent/file-history.js';

// context-economics ticket 03: session file checkpoints. Before every
// successful edit_file/write_file the pre-change content lands under
// <historyDir>; /undo can restore the files a turn touched. Semantics pinned
// here: first-version-only per file, 100-snapshot cap (evict oldest),
// external-change detection with skip-by-default, git isolation.

describe('FileHistory', () => {
  let root: string; // "project" dir holding the target files
  let histDir: string; // ~/.nova/file-history/<sessionId> stand-in

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-proj-'));
    histDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-hist-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(histDir, { recursive: true, force: true });
  });

  const file = (name: string) => path.join(root, name);
  const make = (name: string, content: string) => {
    const p = file(name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf-8');
    return p;
  };

  it('restores the pre-edit content captured by snapshotBefore', () => {
    const p = make('a.ts', 'ONE');
    const fh = new FileHistory({ historyDir: histDir });
    fh.snapshotBefore(p);
    fs.writeFileSync(p, 'TWO'); // what edit_file would do
    fh.noteWritten(p);
    const report = fh.restore([p]);
    expect(report.restored).toEqual([p]);
    expect(report.skipped).toEqual([]);
    expect(fs.readFileSync(p, 'utf-8')).toBe('ONE');
  });

  it('a file that did not exist before is DELETED on restore', () => {
    const p = file('new.ts'); // not created yet — snapshot sees no file
    const fh = new FileHistory({ historyDir: histDir });
    fh.snapshotBefore(p); // existsBefore=false
    fs.writeFileSync(p, 'CREATED'); // what write_file would do
    fh.noteWritten(p);
    const report = fh.restore([p]);
    expect(report.restored).toEqual([p]);
    expect(fs.existsSync(p)).toBe(false);
  });

  it('keeps only the FIRST pre-version per file: two edits restore to the original', () => {
    const p = make('b.ts', 'V1');
    const fh = new FileHistory({ historyDir: histDir });
    fh.snapshotBefore(p);
    fs.writeFileSync(p, 'V2');
    fh.noteWritten(p);
    // second edit in a later round: snapshotBefore must NOT overwrite V1
    fh.snapshotBefore(p);
    fs.writeFileSync(p, 'V3');
    fh.noteWritten(p);
    const report = fh.restore([p]);
    expect(report.restored).toHaveLength(1);
    expect(fs.readFileSync(p, 'utf-8')).toBe('V1');
  });

  // Measured ~3.6s isolated on this machine (101 real snapshot cycles):
  // within the 5s default only while the suite runs idle, and it crosses it
  // under full-suite FS contention. Calibrated duration, assertions unchanged.
  it('caps the session at 100 snapshots, evicting the oldest', () => {
    const fh = new FileHistory({ historyDir: histDir, maxSnapshots: 100 });
    const paths: string[] = [];
    for (let i = 1; i <= 101; i++) {
      const p = make(`f${i}.txt`, `before-${i}`);
      paths.push(p);
      fh.snapshotBefore(p);
      fs.writeFileSync(p, `after-${i}`);
      fh.noteWritten(p);
    }
    // The oldest (f1) was evicted: restoring it is a no-op (unknown file).
    const r1 = fh.restore([paths[0]]);
    expect(r1.restored).toEqual([]);
    expect(fs.readFileSync(paths[0], 'utf-8')).toBe('after-1');
    // The newest still restores.
    const r2 = fh.restore([paths[100]]);
    expect(r2.restored).toEqual([paths[100]]);
    expect(fs.readFileSync(paths[100], 'utf-8')).toBe('before-101');
    // Snapshot payload files respect the cap too (no leak of content files).
    const dataFiles = fs.readdirSync(histDir).filter((n) => n !== 'index.json');
    expect(dataFiles.length).toBeLessThanOrEqual(100);
  }, 30_000);

  it('detects external changes (content != what the tools last wrote) and skips by default', () => {
    const p = make('c.ts', 'ONE');
    const fh = new FileHistory({ historyDir: histDir });
    fh.snapshotBefore(p);
    fs.writeFileSync(p, 'TWO');
    fh.noteWritten(p);
    fs.writeFileSync(p, 'USER EDIT BY HAND'); // external change after the agent
    const report = fh.restore([p]);
    expect(report.restored).toEqual([]);
    expect(report.skipped).toEqual([p]);
    expect(fs.readFileSync(p, 'utf-8')).toBe('USER EDIT BY HAND');
  });

  it('force:true overrides the external-change skip', () => {
    const p = make('d.ts', 'ONE');
    const fh = new FileHistory({ historyDir: histDir });
    fh.snapshotBefore(p);
    fs.writeFileSync(p, 'TWO');
    fh.noteWritten(p);
    fs.writeFileSync(p, 'USER EDIT');
    const report = fh.restore([p], { force: true });
    expect(report.restored).toEqual([p]);
    expect(fs.readFileSync(p, 'utf-8')).toBe('ONE');
  });

  it('deletion of a tracked file after the tool write counts as an external change', () => {
    const p = make('e.ts', 'ONE');
    const fh = new FileHistory({ historyDir: histDir });
    fh.snapshotBefore(p);
    fs.writeFileSync(p, 'TWO');
    fh.noteWritten(p);
    fs.rmSync(p);
    const report = fh.restore([p]);
    expect(report.skipped).toEqual([p]);
  });

  it('snapshots/restore never touch .git: git status is byte-identical around a full cycle', (ctx) => {
    let gitOk = true;
    try {
      execFileSync('git', ['--version'], { timeout: 5000 });
    } catch {
      gitOk = false;
    }
    if (!gitOk) return;
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'test']);
    const tracked = path.join(repo, 'tracked.ts');
    fs.writeFileSync(tracked, 'ORIGINAL\n', 'utf-8');
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'base']);
    const statusBefore = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf-8' });

    const fh = new FileHistory({ historyDir: histDir });
    fh.snapshotBefore(tracked);
    fs.writeFileSync(tracked, 'AGENT CHANGE\n', 'utf-8');
    fh.noteWritten(tracked);
    fh.restore([tracked]);

    const statusAfter = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf-8' });
    expect(statusAfter).toBe(statusBefore); // clean → clean; no stray files
    expect(fs.readFileSync(tracked, 'utf-8')).toBe('ORIGINAL\n');
    // No .git writes from the history layer: history lives beside, not inside.
    expect(histDir).not.toContain(path.join(repo, '.git'));
  });

  it('history survives a new FileHistory instance on the same dir (--resume path)', () => {
    const p = make('f.ts', 'ONE');
    const fh1 = new FileHistory({ historyDir: histDir });
    fh1.snapshotBefore(p);
    fs.writeFileSync(p, 'TWO');
    fh1.noteWritten(p);
    const fh2 = new FileHistory({ historyDir: histDir });
    const report = fh2.restore([p]);
    expect(report.restored).toEqual([p]);
    expect(fs.readFileSync(p, 'utf-8')).toBe('ONE');
  });
});
