import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadConfig } from '../../src/config/loader.js';

describe('Config Loader', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns defaults when no config exists', () => {
    const c = loadConfig(tmpDir);
    expect(c.llm.model).toBe('gpt-4o');
    expect(c.llm.baseUrl).toBe('https://api.openai.com/v1');
    expect(c.agent.maxToolRounds).toBe(50);
  });

  it('merges partial TOML config with defaults', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.toml'), '[llm]\nmodel = "gpt-4o-mini"\napi_key = "sk-test"\n');
    const c = loadConfig(tmpDir);
    expect(c.llm.model).toBe('gpt-4o-mini');
    expect(c.llm.apiKey).toBe('sk-test');
    expect(c.llm.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('reads mcp_servers array', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.toml'), '[[mcp_servers]]\nname = "test"\ncommand = "npx"\nargs = ["-y","test"]\nauto_approve = true\n');
    const c = loadConfig(tmpDir);
    expect(c.mcpServers).toHaveLength(1);
    expect(c.mcpServers[0].name).toBe('test');
    expect(c.mcpServers[0].autoApprove).toBe(true);
  });

  it('reads search config', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.toml'), '[search]\nprovider = "duckduckgo"\n');
    const c = loadConfig(tmpDir);
    expect(c.search.provider).toBe('duckduckgo');
  });

  it('env vars override config file', () => {
    const orig = process.env.CODEAGENT_API_KEY;
    process.env.CODEAGENT_API_KEY = 'sk-env';
    try {
      expect(loadConfig(tmpDir).llm.apiKey).toBe('sk-env');
    } finally {
      orig !== undefined ? (process.env.CODEAGENT_API_KEY = orig) : delete process.env.CODEAGENT_API_KEY;
    }
  });
});
