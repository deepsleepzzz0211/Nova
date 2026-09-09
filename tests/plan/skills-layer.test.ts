/**
 * Skills layer first tests (coverage ticket 02): the REAL SkillRegistry,
 * loader (frontmatter parsing), and installer (local git fixture).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SkillRegistry } from '../../src/skills/registry.js';
import { parseSkillMd } from '../../src/skills/loader.js';
import { installSkill, repoNameFromUrl } from '../../src/skills/installer.js';

const SKILL_A = `---
name: deploy
description: Deploy the application to production safely
---

# Deploy skill

Run deploy.sh first.
`;

const SKILL_B = `---
name: debugging
description: Debugging tips for errors and stack traces
---

# Debugging skill
`;

function writeSkill(dir: string, name: string, raw: string): void {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), raw);
}

describe('parseSkillMd (loader)', () => {
  it('extracts name/description from frontmatter and the body as content', () => {
    const parsed = parseSkillMd(SKILL_A);
    expect(parsed.name).toBe('deploy');
    expect(parsed.description).toContain('Deploy the application');
    expect(parsed.content).toContain('# Deploy skill');
    expect(parsed.content).toContain('Run deploy.sh first.');
  });

  it('throws when frontmatter delimiters are missing', () => {
    expect(() => parseSkillMd('# Just markdown, no frontmatter')).toThrow('missing frontmatter');
  });

  it('throws when the name field is missing', () => {
    const noName = `---\ndescription: only a description\n---\nbody`;
    expect(() => parseSkillMd(noName)).toThrow('missing required "name"');
  });

  it('tolerates CRLF delimiters and empty descriptions', () => {
    const crlf = `---\r\nname: win-skill\r\ndescription:\r\n---\r\nbody text`;
    const parsed = parseSkillMd(crlf);
    expect(parsed.name).toBe('win-skill');
    expect(parsed.description).toBe('');
    expect(parsed.content).toContain('body text');
  });
});

describe('SkillRegistry (real class, temp-dir fixture)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-skills-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('scans recursively, finds SKILL.md files, and exposes findAll/find', async () => {
    writeSkill(dir, 'deploy', SKILL_A);
    writeSkill(path.join(dir, 'nested', 'deep'), 'debugging', SKILL_B);
    // A non-SKILL markdown file must be ignored
    fs.writeFileSync(path.join(dir, 'random.md'), SKILL_A);

    const registry = new SkillRegistry();
    await registry.scan(dir);
    expect(registry.findAll().map((s) => s.name).sort()).toEqual(['debugging', 'deploy']);
    expect(registry.find('deploy')?.description).toContain('Deploy the application');
    expect(registry.find('missing')).toBeUndefined();
  });

  it('skips malformed SKILL.md files silently and rescans from scratch', async () => {
    writeSkill(dir, 'good', SKILL_A);
    writeSkill(dir, 'broken', 'no frontmatter here');
    const registry = new SkillRegistry();
    await registry.scan(dir);
    expect(registry.findAll().map((s) => s.name)).toEqual(['deploy']);

    // Rescan replaces the index (a removed skill disappears)
    fs.rmSync(path.join(dir, 'good'), { recursive: true, force: true });
    await registry.scan(dir);
    expect(registry.findAll()).toEqual([]);
  });

  it('scan tolerates a missing directory', async () => {
    const registry = new SkillRegistry();
    await expect(registry.scan(path.join(dir, 'nope'))).resolves.toBeUndefined();
    expect(registry.findAll()).toEqual([]);
  });

  it('findByKeywords needs ≥2 overlapping tokens with prefix matching', async () => {
    writeSkill(dir, 'debugging', SKILL_B);
    const registry = new SkillRegistry();
    await registry.scan(dir);

    // 2 overlapping tokens ("debugging" name + "errors"/"debugging" in description)
    expect(registry.findByKeywords('debugging errors in production').map((s) => s.name)).toEqual(['debugging']);
    // prefix match: "debug" matches "debugging"
    expect(registry.findByKeywords('debug traces errors').map((s) => s.name)).toEqual(['debugging']);
    // only 1 overlapping token → no match
    expect(registry.findByKeywords('debug')).toEqual([]);
    // empty query → no match
    expect(registry.findByKeywords('')).toEqual([]);
  });

  it('load returns the full SKILL.md content', async () => {
    writeSkill(dir, 'deploy', SKILL_A);
    const registry = new SkillRegistry();
    await registry.scan(dir);
    const meta = registry.find('deploy')!;
    await expect(registry.load(meta)).resolves.toBe(SKILL_A);
  });
});

describe('installSkill (local git fixture — no network)', () => {
  let home: string;
  let fixtureRepo: string;
  const savedNovaHome = process.env.NOVA_HOME;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-install-'));
    process.env.NOVA_HOME = home;
    // Build a local git repo to clone from
    fixtureRepo = path.join(home, 'fixture-repo-src');
    fs.mkdirSync(fixtureRepo, { recursive: true });
    fs.writeFileSync(path.join(fixtureRepo, 'SKILL.md'), SKILL_A);
    execSync('git init -q', { cwd: fixtureRepo });
    execSync('git add -A', { cwd: fixtureRepo });
    execSync('git -c user.email=t@t -c user.name=t commit -q -m init', { cwd: fixtureRepo });
  });

  afterEach(() => {
    if (savedNovaHome === undefined) delete process.env.NOVA_HOME;
    else process.env.NOVA_HOME = savedNovaHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('extracts repo names from HTTPS and SSH URLs', () => {
    expect(repoNameFromUrl('https://host/user/my-skills.git')).toBe('my-skills');
    expect(repoNameFromUrl('git@host:user/other-skills.git')).toBe('other-skills');
    expect(repoNameFromUrl('https://host/user/plain-name')).toBe('plain-name');
    expect(repoNameFromUrl('git@host:nested/path/repo.git')).toBe('repo');
  });

  it('clones the fixture repo into ~/.nova/skills/<repo-name>', () => {
    const installed = installSkill(fixtureRepo);
    expect(installed).toBe(path.join(home, '.nova', 'skills', 'fixture-repo-src'));
    expect(fs.existsSync(path.join(installed, 'SKILL.md'))).toBe(true);
  });

  it('refuses to install into an existing directory', () => {
    installSkill(fixtureRepo);
    expect(() => installSkill(fixtureRepo)).toThrow('Skill already installed');
  });
});
