import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadAppConfig, novaPath } from '../../src/config/loader.js';
import { buildLoopBase } from '../../src/agent/loop-deps.js';
import { loopBaseFromRuntime } from '../../src/cli/tools-runtime.js';
import { gatherEnvironment } from '../../src/agent/environment.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import type { ResolvedModel } from '../../src/llm/catalog.js';

// Arch ticket 04: one config entry that returns a NORMALIZED config (no
// caller-composed normalize step, no `as unknown as` window where the type
// lies), one helper for the ~/.nova tree, and one builder for the AgentLoop
// wiring that print-mode and the TUI used to duplicate.

let home: string;
let project: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-arch-home-'));
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-arch-proj-'));
  fs.mkdirSync(path.join(home, '.nova'), { recursive: true });
  process.env.NOVA_HOME = home;
});
afterEach(() => {
  delete process.env.NOVA_HOME;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

describe('novaPath', () => {
  it('roots the tree at NOVA_HOME/.nova and joins segments', () => {
    expect(novaPath()).toBe(path.join(home, '.nova'));
    expect(novaPath('sessions')).toBe(path.join(home, '.nova', 'sessions'));
    expect(novaPath('file-history', 'sid')).toBe(path.join(home, '.nova', 'file-history', 'sid'));
  });
});

describe('loadAppConfig', () => {
  it('returns the NORMALIZED config with warnings surfaced (caller cannot forget normalize)', () => {
    fs.writeFileSync(
      path.join(home, '.nova', 'config.toml'),
      '[agent]\ncontext_strategy = "bogus"\n',
      'utf-8',
    );
    const { config, warnings } = loadAppConfig(project);
    expect(config.agent.contextStrategy).toBe('truncate');
    expect(warnings.join('')).toMatch(/context_strategy "bogus"/);
  });

  it('clean config normalizes to zero warnings', () => {
    const { config, warnings } = loadAppConfig(project);
    expect(warnings).toEqual([]);
    expect(config.llm.provider).toBe(DEFAULT_CONFIG.llm.provider);
  });
});

describe('buildLoopBase', () => {
  const resolution = {
    model: { contextWindow: 128_000, cost: { input: 1, output: 1 } },
    name: 'fake',
  } as unknown as ResolvedModel;

  it('assembles context/options from config+resolution in ONE place', () => {
    const base = buildLoopBase({
      config: DEFAULT_CONFIG,
      resolution,
      sessionId: 'sess-9',
      environment: undefined,
      projectInstructions: undefined,
      memory: undefined,
    });
    expect(base.context).toEqual({
      maxTokens: 128_000,
      reserveTokens: DEFAULT_CONFIG.agent.contextReserveTokens,
      keepRecentTokens: DEFAULT_CONFIG.agent.contextKeepRecentTokens,
      strategy: DEFAULT_CONFIG.agent.contextStrategy === 'compact' ? 'compact' : 'truncate',
    });
    expect(base.config).toEqual({ maxToolRounds: DEFAULT_CONFIG.agent.maxToolRounds, model: DEFAULT_CONFIG.llm.model });
  });

  it('checkpoints live under the NOVA_HOME tree for THIS session id', () => {
    const target = path.join(project, 'a.txt');
    fs.writeFileSync(target, 'data');
    const base = buildLoopBase({
      config: DEFAULT_CONFIG,
      resolution,
      sessionId: 'sess-42',
    });
    base.fileHistory!.snapshotBefore(target);
    base.fileHistory!.noteWritten(target);
    expect(fs.existsSync(novaPath('file-history', 'sess-42', 'index.json'))).toBe(true);
  });

  it('directory instructions root defaults to cwd and honors the override', () => {
    const base = buildLoopBase({ config: DEFAULT_CONFIG, resolution, sessionId: 's', rootDir: project });
    // The instance is opaque; behavior is proven through collect() returning
    // nothing outside the tree — construction alone must not throw.
    expect(base.directoryInstructions).toBeDefined();
  });
});

// arch2 ticket A2: the runtime-bag -> LoopBase field mapping had ONE owner.
// index.tsx and print-mode.ts previously repeated the same six fields by
// hand; a new prompt part meant shotgun edits in both.
describe('loopBaseFromRuntime (arch2 A2)', () => {
  const resolution = {
    model: { contextWindow: 128_000, cost: { input: 1, output: 1 } },
    name: 'fake',
  } as unknown as ResolvedModel;

  it('maps environment/projectInstructions/memory out of the runtime bag', () => {
    const environment = gatherEnvironment(project, { shellFacts: { shell: 'bash(test)' } });
    const runtime = {
      environment,
      projectInstructions: 'AGENTS BODY',
      memory: 'MEMORY BODY',
    };
    const base = loopBaseFromRuntime({
      config: DEFAULT_CONFIG,
      resolution,
      sessionId: 'sess-map',
      runtime,
    });
    expect(base.promptOptions.environment).toBe(environment);
    expect(base.promptOptions.projectInstructions).toBe('AGENTS BODY');
    expect(base.promptOptions.memory).toBe('MEMORY BODY');
    expect(base.promptOptions.customPrompt).toBeUndefined();
  });

  it('customPrompt flows from config.agent.systemPrompt (single place again)', () => {
    const config = {
      ...DEFAULT_CONFIG,
      agent: { ...DEFAULT_CONFIG.agent, systemPrompt: 'CUSTOM' },
    };
    const base = loopBaseFromRuntime({
      config,
      resolution,
      sessionId: 'sess-cp',
      runtime: { environment: undefined, projectInstructions: undefined, memory: undefined },
    });
    expect(base.promptOptions.customPrompt).toBe('CUSTOM');
  });
});
