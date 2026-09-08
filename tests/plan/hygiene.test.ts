import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { normalizeConfig } from '../../src/config/loader.js';
import { SessionStore } from '../../src/agent/session.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

describe('normalizeConfig', () => {
  it('passes a valid config through without warnings', () => {
    const { config, warnings } = normalizeConfig(DEFAULT_CONFIG);
    expect(warnings).toEqual([]);
    expect(config.agent.contextStrategy).toBe('truncate');
  });

  it('warns and falls back on an unknown context_strategy', () => {
    const bad = { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, contextStrategy: 'summarize' } };
    const { config, warnings } = normalizeConfig(bad);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('summarize');
    expect(config.agent.contextStrategy).toBe('truncate');
  });

  it('warns and falls back on subagent_max_concurrent < 1', () => {
    const bad = { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, subagentMaxConcurrent: 0 } };
    const { config, warnings } = normalizeConfig(bad);
    expect(warnings).toHaveLength(1);
    expect(config.agent.subagentMaxConcurrent).toBe(3);
  });
});

describe('SessionStore.sweep', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-sweep-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('removes session files older than the retention window and keeps fresh ones', () => {
    const old = path.join(dir, 'session-old.jsonl');
    const fresh = path.join(dir, 'session-new.jsonl');
    fs.writeFileSync(old, '{"role":"user","content":"old"}\n');
    fs.writeFileSync(fresh, '{"role":"user","content":"new"}\n');
    const past = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old, past, past);

    expect(SessionStore.sweep(dir, 30)).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('returns 0 for empty or missing directories', () => {
    expect(SessionStore.sweep(dir, 30)).toBe(0);
    expect(SessionStore.sweep(path.join(dir, 'nope'), 30)).toBe(0);
  });
});
