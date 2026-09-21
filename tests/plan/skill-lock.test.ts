import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'node:crypto';
import {
  SKILL_LOCK_FILENAME,
  sha256File,
  buildSkillLock,
  writeSkillLock,
  readSkillLock,
  lockDirFor,
  verifySkillFile,
} from '../../src/skills/skill-lock.js';
import { SkillRegistry } from '../../src/skills/registry.js';

/**
 * Ticket zcode-borrow 04 — skills-lock: sha256 integrity pinning for
 * third-party skill repos. A lock file lives inside an installed repo; the
 * registry refuses to load skills that drifted or were added without a lock
 * entry. Hand-written skills with no lock are unaffected.
 */

const SKILL_A = `---\nname: alpha\ndescription: Alpha skill\n---\n\n# Alpha\nbody A\n`;
const SKILL_B = `---\nname: beta\ndescription: Beta skill\n---\n\n# Beta\nbody B\n`;

function putSkill(root: string, sub: string, raw: string): string {
  const dir = sub ? path.join(root, sub) : root;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, raw);
  return file;
}

describe('skill-lock primitives', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-lock-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('sha256File matches node crypto over the raw bytes', () => {
    const file = putSkill(root, '', SKILL_A);
    const expected = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    expect(sha256File(file)).toBe(expected);
  });

  it('buildSkillLock records every SKILL.md with a posix-relative path', () => {
    putSkill(root, 'alpha', SKILL_A);
    putSkill(root, 'nested/beta', SKILL_B);
    const lock = buildSkillLock(root, 'github:acme/skills');
    expect(lock.source).toBe('github:acme/skills');
    expect(lock.version).toBe(1);
    expect(lock.skills.map((s) => s.path).sort()).toEqual(['alpha/SKILL.md', 'nested/beta/SKILL.md']);
  });

  it('write/read round-trips through the repo-local lock file', () => {
    putSkill(root, 'alpha', SKILL_A);
    const written = writeSkillLock(root, 'github:acme/skills');
    expect(fs.existsSync(path.join(root, SKILL_LOCK_FILENAME))).toBe(true);
    const read = readSkillLock(path.join(root, SKILL_LOCK_FILENAME));
    expect(read).toEqual(written);
  });

  it('readSkillLock returns null for a missing or malformed file', () => {
    expect(readSkillLock(path.join(root, 'nope.json'))).toBeNull();
    fs.writeFileSync(path.join(root, SKILL_LOCK_FILENAME), '{ not json');
    expect(readSkillLock(path.join(root, SKILL_LOCK_FILENAME))).toBeNull();
  });

  it('lockDirFor finds the nearest enclosing lock, staying under the scan root', () => {
    putSkill(root, 'repo/alpha', SKILL_A);
    writeSkillLock(path.join(root, 'repo'), 'x');
    const skillFile = path.join(root, 'repo', 'alpha', 'SKILL.md');
    expect(lockDirFor(skillFile, root)).toBe(path.join(root, 'repo'));
    // Nothing above root governs an untracked skill
    putSkill(root, 'loose', SKILL_B);
    expect(lockDirFor(path.join(root, 'loose', 'SKILL.md'), root)).toBeNull();
  });

  it('verifySkillFile reports match / drift / unpinned', () => {
    const aFile = putSkill(root, 'alpha', SKILL_A);
    const lock = writeSkillLock(root, 'x');
    expect(verifySkillFile(root, aFile, lock).status).toBe('match');
    // drift: tamper the file
    fs.writeFileSync(aFile, SKILL_A + 'tampered');
    const drift = verifySkillFile(root, aFile, lock);
    expect(drift.status).toBe('drift');
    // unpinned: a skill not listed in the lock
    const bFile = putSkill(root, 'beta', SKILL_B);
    expect(verifySkillFile(root, bFile, lock).status).toBe('unpinned');
  });
});

describe('SkillRegistry lock enforcement', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-reg-lock-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('loads matching skills and stays silent', async () => {
    putSkill(root, 'alpha', SKILL_A);
    writeSkillLock(root, 'github:acme/skills');
    const warnings: string[] = [];
    const reg = new SkillRegistry();
    await reg.scan(root, { onWarn: (m) => warnings.push(m) });
    expect(reg.find('alpha')).toBeDefined();
    expect(warnings).toEqual([]);
  });

  it('rejects a drifted skill with an expected/actual warning', async () => {
    const file = putSkill(root, 'alpha', SKILL_A);
    writeSkillLock(root, 'x');
    fs.writeFileSync(file, SKILL_A.replace('body A', 'body TAMPERED'));
    const warnings: string[] = [];
    const reg = new SkillRegistry();
    await reg.scan(root, { onWarn: (m) => warnings.push(m) });
    expect(reg.find('alpha')).toBeUndefined();
    expect(warnings.some((w) => /drift|hash/i.test(w))).toBe(true);
  });

  it('rejects an added-without-a-lock-entry skill by default', async () => {
    putSkill(root, 'alpha', SKILL_A);
    writeSkillLock(root, 'x');
    putSkill(root, 'sneaky', `---\nname: sneaky\ndescription: evil\n---\nbody`);
    const warnings: string[] = [];
    const reg = new SkillRegistry();
    await reg.scan(root, { onWarn: (m) => warnings.push(m) });
    expect(reg.find('alpha')).toBeDefined(); // pinned + matching still loads
    expect(reg.find('sneaky')).toBeUndefined();
    expect(warnings.some((w) => /lock|unpinned/i.test(w))).toBe(true);
  });

  it('a lock in one repo does not affect an untracked sibling skill', async () => {
    putSkill(root, 'repo/alpha', SKILL_A);
    writeSkillLock(path.join(root, 'repo'), 'x');
    putSkill(root, 'loose', SKILL_B); // hand-written, no lock
    const warnings: string[] = [];
    const reg = new SkillRegistry();
    await reg.scan(root, { onWarn: (m) => warnings.push(m) });
    expect(reg.find('alpha')).toBeDefined();
    expect(reg.find('beta')).toBeDefined();
    expect(warnings).toEqual([]);
  });

  it('a malformed lock FAILS CLOSED: every skill under it is refused', async () => {
    putSkill(root, 'alpha', SKILL_A);
    fs.writeFileSync(path.join(root, SKILL_LOCK_FILENAME), '{ corrupted');
    const warnings: string[] = [];
    const reg = new SkillRegistry();
    await reg.scan(root, { onWarn: (m) => warnings.push(m) });
    expect(reg.find('alpha')).toBeUndefined();
    expect(warnings.some((w) => /unreadable|corrupt|malformed/i.test(w))).toBe(true);
  });

  it('backward compatible: no lock file means everything loads (no options)', async () => {
    putSkill(root, 'alpha', SKILL_A);
    const reg = new SkillRegistry();
    await reg.scan(root);
    expect(reg.find('alpha')).toBeDefined();
  });
});
