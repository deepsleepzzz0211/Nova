import { describe, it, expect } from 'vitest';
import { ContextManager } from '../../src/agent/context.js';

describe('ContextManager', () => {
  it('counts tokens in messages', () => {
    const cm = new ContextManager({ model: 'gpt-4o', maxTokens: 128000 });
    const msgs = [
      { role: 'user' as const, content: 'Hello, how are you?' },
      { role: 'assistant' as const, content: 'I am doing well, thank you!' },
    ];
    const count = cm.countTokens(msgs);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(100); // short messages
  });

  it('truncates oldest messages when over limit', () => {
    const cm = new ContextManager({ model: 'gpt-4o', maxTokens: 100 }); // tiny limit
    const msgs = Array.from({ length: 50 }, (_, i) => ({
      role: 'user' as const,
      content: `Message number ${i}: ${'x'.repeat(100)}`,
    }));
    const truncated = cm.truncate(msgs);
    expect(truncated.length).toBeLessThan(msgs.length);
  });

  it('always keeps system message', () => {
    const cm = new ContextManager({ model: 'gpt-4o', maxTokens: 100 });
    const msgs = [
      { role: 'system' as const, content: 'You are a helpful assistant' },
      ...Array.from({ length: 20 }, (_, i) => ({ role: 'user' as const, content: `msg ${i} ${'x'.repeat(50)}` })),
    ];
    const truncated = cm.truncate(msgs);
    expect(truncated[0].role).toBe('system');
  });

  it('isNearLimit uses the effective window (reserve capped at 21K + safety buffer)', () => {
    // zcode-borrow ticket 02: trigger = window − min(reserve, 21K) − 13K buffer
    for (const window of [128_000, 200_000, 1_000_000]) {
      const cm = new ContextManager({ model: 'gpt-4o', maxTokens: window });
      expect(cm.triggerTokens).toBe(window - 16_384 - 13_000);
      expect(cm.isNearLimit(window - 16_384 - 13_000)).toBe(true);
      expect(cm.isNearLimit(window - 16_384 - 13_000 - 1)).toBe(false);
    }
  });

  it('clamps the reserve to half the window for tiny windows', () => {
    // maxTokens 100: full 16384 reserve would make the trigger negative
    const tiny = new ContextManager({ model: 'gpt-4o', maxTokens: 100 });
    expect(tiny.triggerTokens).toBe(50); // reserve clamped to maxTokens/2
  });

  it('honors an explicit reserveTokens override (still capped at 21K)', () => {
    const cm = new ContextManager({ model: 'gpt-4o', maxTokens: 200_000, reserveTokens: 40_000 });
    // min(40000, 21000) + 13000 buffer
    expect(cm.triggerTokens).toBe(200_000 - 21_000 - 13_000);
  });

  it('override is also clamped to half the window', () => {
    const cm = new ContextManager({ model: 'gpt-4o', maxTokens: 100, reserveTokens: 90 });
    expect(cm.triggerTokens).toBe(50);
  });
});
