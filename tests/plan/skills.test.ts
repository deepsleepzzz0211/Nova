import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SkillRegistry } from '../../src/skills/registry.js';

describe('SkillRegistry', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('scans directory and parses SKILL.md frontmatter', async () => {
    const skillDir = path.join(tmp, 'my-skill');
    fs.mkdirSync(skillDir);
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: my-skill\ndescription: Use when testing\n---\n# My Skill\nDo stuff.');

    const reg = new SkillRegistry();
    await reg.scan(tmp);
    const skills = reg.findAll();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('my-skill');
    expect(skills[0].description).toBe('Use when testing');
  });

  it('finds skill by exact name', async () => {
    const skillDir = path.join(tmp, 'coding');
    fs.mkdirSync(skillDir);
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: coding\ndescription: For coding tasks\n---\n# Coding');

    const reg = new SkillRegistry();
    await reg.scan(tmp);
    expect(reg.find('coding')).toBeDefined();
    expect(reg.find('nonexistent')).toBeUndefined();
  });

  it('finds skills by keyword match', async () => {
    const skillDir = path.join(tmp, 'debug');
    fs.mkdirSync(skillDir);
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: debug\ndescription: Use when debugging bugs and errors\n---\n# Debug');

    const reg = new SkillRegistry();
    await reg.scan(tmp);
    const found = reg.findByKeywords('help me debug this error');
    expect(found.length).toBeGreaterThan(0);
  });

  it('loads full skill content', async () => {
    const skillDir = path.join(tmp, 'test-skill');
    fs.mkdirSync(skillDir);
    const content = '---\nname: test\ndescription: test\n---\n# Full Content\nHere is the full skill content.';
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);

    const reg = new SkillRegistry();
    await reg.scan(tmp);
    const skill = reg.find('test')!;
    const loaded = await reg.load(skill);
    expect(loaded).toContain('# Full Content');
  });
});
