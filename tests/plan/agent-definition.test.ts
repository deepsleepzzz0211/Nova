import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseAgentFile, loadAgentDefinitions } from '../../src/subagent/agents.js';

// Batch-B ticket 05: ~/.nova/agents/<name>.toml declares a named subagent —
// description, tool whitelist, optional model, multiline system prompt and
// the readOnly derived bit. Invalid definitions warn and are skipped; they
// never block startup.

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-agents-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseAgentFile', () => {
  it('parses the full field set', () => {
    const def = parseAgentFile(
      'reviewer.toml',
      [
        'description = "read-only code reviewer"',
        'tools = ["grep", "glob", "read_file"]',
        'model = "cheap-model"',
        'readOnly = true',
        'prompt = """',
        'Review the diff. Never modify files.',
        'Report findings as a list.',
        '"""',
      ].join('\n'),
    );
    expect(def).not.toBeNull();
    expect(def?.name).toBe('reviewer');
    expect(def?.description).toBe('read-only code reviewer');
    expect(def?.tools).toEqual(['grep', 'glob', 'read_file']);
    expect(def?.model).toBe('cheap-model');
    expect(def?.readOnly).toBe(true);
    expect(def?.prompt).toContain('Never modify files');
  });

  it('defaults: readOnly false, model absent', () => {
    const def = parseAgentFile('a.toml', 'description = "d"\ntools = ["read_file"]\nprompt = "p"\n');
    expect(def?.readOnly).toBe(false);
    expect(def?.model).toBeUndefined();
  });

  it('rejects non-kebab names with a warning', () => {
    const warnings: string[] = [];
    const def = parseAgentFile('Bad_Name.toml', 'description = "d"\ntools = []\nprompt = "p"', (m) => warnings.push(m));
    expect(def).toBeNull();
    expect(warnings.join('')).toMatch(/Bad_Name/);
  });

  it('rejects missing prompt / tools / description and unparseable TOML', () => {
    const warnings: string[] = [];
    const warn = (m: string): void => { warnings.push(m); };
    expect(parseAgentFile('x.toml', 'description = "d"\ntools = ["a"]', warn)).toBeNull();
    expect(parseAgentFile('y.toml', 'description = "d"\nprompt = "p"', warn)).toBeNull();
    expect(parseAgentFile('z.toml', 'tools = ["a"]\nprompt = "p"', warn)).toBeNull();
    expect(parseAgentFile('bad.toml', 'this is not = toml = at all', warn)).toBeNull();
    expect(parseAgentFile('empty.toml', '', warn)).toBeNull();
    expect(warnings.length).toBe(5);
  });

  it('rejects wrong field types (tools must be a string array)', () => {
    expect(parseAgentFile('t.toml', 'description = "d"\ntools = "read_file"\nprompt = "p"')).toBeNull();
  });
});

describe('loadAgentDefinitions', () => {
  it('returns an empty map for a missing directory', () => {
    expect(loadAgentDefinitions(path.join(dir, 'nope')).size).toBe(0);
  });

  it('loads valid files, skips invalid ones with warnings, keyed by name', () => {
    fs.writeFileSync(path.join(dir, 'reviewer.toml'), 'description = "r"\ntools = ["read_file"]\nprompt = "rp"\nreadOnly = true');
    fs.writeFileSync(path.join(dir, 'broken.toml'), 'description = "b"');
    const warnings: string[] = [];
    const map = loadAgentDefinitions(dir, (m) => warnings.push(m));
    expect([...map.keys()]).toEqual(['reviewer']);
    expect(map.get('reviewer')?.readOnly).toBe(true);
    expect(warnings.join('')).toMatch(/broken\.toml/);
  });

  it('ignores non-.toml files', () => {
    fs.writeFileSync(path.join(dir, 'notes.md'), 'anything');
    expect(loadAgentDefinitions(dir).size).toBe(0);
  });
});
