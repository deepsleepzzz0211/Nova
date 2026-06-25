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

  it('isNearLimit returns true when close to max', () => {
    const cm = new ContextManager({ model: 'gpt-4o', maxTokens: 100 });
    expect(cm.isNearLimit(85)).toBe(true);  // 85% of 100
    expect(cm.isNearLimit(50)).toBe(false);
  });
});
