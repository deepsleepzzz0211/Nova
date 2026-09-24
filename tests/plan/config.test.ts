import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadConfig, normalizeConfig } from '../../src/config/loader.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { AppConfig } from '../../src/config/schema.js';

describe('Config Loader', () => {
  let tmpDir: string;
  let savedNovaHome: string | undefined;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    // Isolate from the real user-level ~/.nova/config.toml
    savedNovaHome = process.env.NOVA_HOME;
    process.env.NOVA_HOME = tmpDir;
  });
  afterEach(() => {
    if (savedNovaHome === undefined) delete process.env.NOVA_HOME;
    else process.env.NOVA_HOME = savedNovaHome;
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns defaults when no config exists', () => {
    const c = loadConfig(tmpDir);
    expect(c.llm.model).toBe('gpt-4o');
    expect(c.llm.baseUrl).toBe('https://api.openai.com/v1');
    expect(c.agent.maxToolRounds).toBe(50);
    expect(c.agent.contextReserveTokens).toBe(16384);
    expect(c.agent.contextKeepRecentTokens).toBe(20000);
  });

  it('honors context reserve / keep-recent overrides from TOML', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'config.toml'),
      '[agent]\ncontext_reserve_tokens = 8000\ncontext_keep_recent_tokens = 12000\n',
    );
    const c = loadConfig(tmpDir);
    expect(c.agent.contextReserveTokens).toBe(8000);
    expect(c.agent.contextKeepRecentTokens).toBe(12000);
  });

  it('defaults llm.stream_max_retries to 1', () => {
    const c = loadConfig(tmpDir);
    expect(c.llm.streamMaxRetries).toBe(1);
  });

  it('honors llm.stream_max_retries from TOML', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.toml'), '[llm]\nstream_max_retries = 0\n');
    const c = loadConfig(tmpDir);
    expect(c.llm.streamMaxRetries).toBe(0);
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
    fs.writeFileSync(path.join(tmpDir, 'config.toml'), '[search]\nprovider = "tavily"\ntavily_api_key = "tvly-x"\n');
    const c = loadConfig(tmpDir);
    expect(c.search.provider).toBe('tavily');
    expect(c.search.tavilyApiKey).toBe('tvly-x');
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

describe('llm.cache_retention validation (cache-hit 02)', () => {
  const base = DEFAULT_CONFIG;
  it('accepts a valid retention value verbatim', () => {
    const { config, warnings } = normalizeConfig({
      ...base, llm: { ...base.llm, cacheRetention: 'long' },
    } as AppConfig);
    expect(config.llm.cacheRetention).toBe('long');
    expect(warnings).toEqual([]);
  });
  it('rejects an unknown value with a warning and drops it', () => {
    const { config, warnings } = normalizeConfig({
      ...base, llm: { ...base.llm, cacheRetention: 'forever' },
    } as unknown as AppConfig);
    expect(config.llm.cacheRetention).toBeUndefined();
    expect(warnings.join(' ')).toMatch(/cache_retention/);
  });
});
