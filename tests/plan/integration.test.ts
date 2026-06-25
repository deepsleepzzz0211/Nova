import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ToolRegistry } from '../../src/tools/registry.js';
import { createReadFileTool } from '../../src/tools/read-file.js';
import { createWriteFileTool } from '../../src/tools/write-file.js';
import { createEditFileTool } from '../../src/tools/edit-file.js';
import { createBashTool } from '../../src/tools/bash.js';
import { createWebSearchTool } from '../../src/tools/web-search.js';
import { createWebFetchTool } from '../../src/tools/web-fetch.js';
import { PermissionPolicy } from '../../src/permission/policy.js';
import { loadConfig } from '../../src/config/loader.js';
import { SkillRegistry } from '../../src/skills/registry.js';

describe('Integration: all tools register and policy works', () => {
  it('registers all 6 built-in tools', () => {
    const reg = new ToolRegistry();
    reg.register(createReadFileTool());
    reg.register(createWriteFileTool());
    reg.register(createEditFileTool());
    reg.register(createBashTool());
    reg.register(createWebSearchTool());
    reg.register(createWebFetchTool());

    expect(reg.getAll()).toHaveLength(6);
    expect(reg.toToolDefinitions()).toHaveLength(6);
    expect(reg.get('read_file')).toBeDefined();
    expect(reg.get('bash')).toBeDefined();
  });

  it('policy correctly gates all tool types', () => {
    const policy = new PermissionPolicy({
      autoApproveFileWrite: false,
      autoApproveBash: false,
      alwaysAllowCommands: ['git status'],
    });

    expect(policy.check('read_file', {}).decision).toBe('allow');
    expect(policy.check('edit_file', {}).decision).toBe('allow');
    expect(policy.check('web_search', {}).decision).toBe('allow');
    expect(policy.check('web_fetch', {}).decision).toBe('allow');
    expect(policy.check('write_file', {}).decision).toBe('ask');
    expect(policy.check('bash', { command: 'npm test' }).decision).toBe('ask');
    expect(policy.check('bash', { command: 'git status' }).decision).toBe('allow');
    expect(policy.check('bash', { command: 'rm -rf /' }).decision).toBe('ask');
  });

  it('tool definitions contain correct name, description, and parameters', () => {
    const reg = new ToolRegistry();
    reg.register(createReadFileTool());
    reg.register(createWriteFileTool());
    reg.register(createEditFileTool());
    reg.register(createBashTool());
    reg.register(createWebSearchTool());
    reg.register(createWebFetchTool());

    const defs = reg.toToolDefinitions();
    const names = defs.map((d) => d.function.name).sort();
    expect(names).toEqual(['bash', 'edit_file', 'read_file', 'web_fetch', 'web_search', 'write_file']);

    // Each definition must have description and parameters
    for (const def of defs) {
      expect(def.function.description).toBeTruthy();
      expect(def.function.parameters).toBeDefined();
      expect(def.function.parameters.type).toBe('object');
    }
  });
});

describe('Integration: config loads from TOML with defaults', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-cfg-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns full default config when no config exists', () => {
    const c = loadConfig(tmpDir);
    // LLM defaults
    expect(c.llm.model).toBe('gpt-4o');
    expect(c.llm.baseUrl).toBe('https://api.openai.com/v1');
    expect(c.llm.maxTokens).toBe(4096);
    expect(c.llm.temperature).toBe(0.7);
    // Agent defaults
    expect(c.agent.maxToolRounds).toBe(50);
    expect(c.agent.contextStrategy).toBe('truncate');
    // Search defaults
    expect(c.search.provider).toBe('tavily');
    // Permission defaults
    expect(c.permission.autoApproveFileWrite).toBe(false);
    expect(c.permission.autoApproveBash).toBe(false);
    expect(c.permission.alwaysAllowCommands).toEqual([]);
    // MCP defaults
    expect(c.mcpServers).toEqual([]);
  });

  it('merges partial TOML with defaults preserving unconfigured fields', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'config.toml'),
      '[llm]\nmodel = "gpt-4o-mini"\napi_key = "sk-test"\n\n[agent]\nmax_tool_rounds = 10\n',
    );
    const c = loadConfig(tmpDir);
    // Overridden fields
    expect(c.llm.model).toBe('gpt-4o-mini');
    expect(c.llm.apiKey).toBe('sk-test');
    expect(c.agent.maxToolRounds).toBe(10);
    // Preserved defaults
    expect(c.llm.baseUrl).toBe('https://api.openai.com/v1');
    expect(c.llm.temperature).toBe(0.7);
    expect(c.search.provider).toBe('tavily');
    expect(c.permission.autoApproveFileWrite).toBe(false);
    expect(c.mcpServers).toEqual([]);
  });

  it('config integrates with permission policy via alwaysAllowCommands', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'config.toml'),
      '[permission]\nauto_approve_file_write = true\nauto_approve_bash = true\nalways_allow_commands = ["git status", "git diff"]\n',
    );
    const c = loadConfig(tmpDir);

    // Config reads TOML values correctly
    expect(c.permission.autoApproveFileWrite).toBe(true);
    expect(c.permission.autoApproveBash).toBe(true);
    expect(c.permission.alwaysAllowCommands).toEqual(['git status', 'git diff']);

    // Policy uses alwaysAllowCommands from config
    const policy = new PermissionPolicy(c.permission);
    expect(policy.check('bash', { command: 'git status' }).decision).toBe('allow');
    expect(policy.check('bash', { command: 'git diff' }).decision).toBe('allow');
    expect(policy.check('bash', { command: 'git diff --stat' }).decision).toBe('allow');
    // Read-only tools always allow
    expect(policy.check('read_file', {}).decision).toBe('allow');
    // Dangerous commands still ask
    expect(policy.check('bash', { command: 'rm -rf /' }).decision).toBe('ask');
  });
});

describe('Integration: skill registry end-to-end', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-sk-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  function createSkill(dir: string, name: string, description: string, body: string): void {
    const skillDir = path.join(dir, name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`);
  }

  it('scans multiple skills and finds by name and keywords', async () => {
    createSkill(tmp, 'coding', 'For coding and development tasks', '# Coding\nWrite code.');
    createSkill(tmp, 'debugging', 'Use when debugging bugs and errors', '# Debug\nFix bugs.');
    createSkill(tmp, 'testing', 'Write and run tests for code quality', '# Testing\nTest code.');

    const reg = new SkillRegistry();
    await reg.scan(tmp);
    expect(reg.findAll()).toHaveLength(3);

    // Find by exact name
    expect(reg.find('coding')).toBeDefined();
    expect(reg.find('debugging')).toBeDefined();
    expect(reg.find('testing')).toBeDefined();
    expect(reg.find('nonexistent')).toBeUndefined();

    // Find by keywords
    const debugResults = reg.findByKeywords('help me debug these bugs');
    expect(debugResults.length).toBeGreaterThan(0);
    expect(debugResults.some((s) => s.name === 'debugging')).toBe(true);

    const testResults = reg.findByKeywords('need to write tests');
    expect(testResults.length).toBeGreaterThan(0);
    expect(testResults.some((s) => s.name === 'testing')).toBe(true);
  });

  it('loads full skill content and metadata stays consistent', async () => {
    createSkill(tmp, 'deploy', 'Deploy applications to production', '# Deploy\nRun deploy steps.');

    const reg = new SkillRegistry();
    await reg.scan(tmp);

    const skill = reg.find('deploy');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('deploy');
    expect(skill!.description).toBe('Deploy applications to production');

    const content = await reg.load(skill!);
    expect(content).toContain('# Deploy');
    expect(content).toContain('Run deploy steps.');
    expect(content).toContain('name: deploy');
  });

  it('handles empty and missing directories gracefully', async () => {
    const reg = new SkillRegistry();
    // Non-existent directory
    await reg.scan(path.join(tmp, 'nonexistent'));
    expect(reg.findAll()).toHaveLength(0);

    // Empty directory
    await reg.scan(tmp);
    expect(reg.findAll()).toHaveLength(0);
  });
});
