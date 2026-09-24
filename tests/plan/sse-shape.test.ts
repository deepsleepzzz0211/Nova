import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
// @ts-expect-error plain ESM helper without types (scripts/lib) — accepted seam for test reuse
import { parseSseEvents, assertShape } from '../../scripts/lib/sse-shape.mjs';

const fixture = (name: string): string =>
  fs.readFileSync(path.resolve('tests/e2e/fixtures/recorded', name), 'utf-8');

describe('sse-shape validator against REAL recordings (test-effectiveness 02)', () => {
  it('accepts the recorded text turn byte-for-byte', () => {
    const r = assertShape(fixture('weixin-text.sse'));
    expect(r.hasToolCalls).toBe(false);
    expect(r.usage.prompt_tokens).toBeGreaterThan(0);
  });

  it('accepts the recorded tool-call turn (split arguments included)', () => {
    const r = assertShape(fixture('weixin-toolcall.sse'));
    expect(r.hasToolCalls).toBe(true);
  });

  it('rejects a stream whose [DONE] sentinel vanished', () => {
    const raw = fixture('weixin-text.sse').replace(/\s*data: \[DONE\]\s*\n?$/, '\n');
    expect(() => assertShape(raw)).toThrow(/\[DONE\]/);
  });

  it('rejects a renamed usage field (contract drift: prompt_tokens gone)', () => {
    const raw = fixture('weixin-text.sse').replace(/"prompt_tokens":/g, '"input_tokens":');
    expect(() => assertShape(raw)).toThrow(/prompt_tokens/);
  });

  it('rejects a cache field that changed type (drift tripwire)', () => {
    const raw = fixture('weixin-text.sse').replace(
      '"prompt_tokens":15',
      '"prompt_tokens":15,"prompt_cache_hit_tokens":"many"',
    );
    expect(() => assertShape(raw)).toThrow(/prompt_cache_hit_tokens/);
  });

  it('rejects a non-JSON data payload', () => {
    const raw = fixture('weixin-text.sse').replace('data: {"id"', 'data: {broken');
    expect(() => parseSseEvents(raw)).toThrow(/not JSON/);
  });

  it('rejects a first event without assistant role', () => {
    const raw = fixture('weixin-text.sse').replace('"role":"assistant"', '"role":"helper"');
    expect(() => assertShape(raw)).toThrow(/assistant/);
  });
});
