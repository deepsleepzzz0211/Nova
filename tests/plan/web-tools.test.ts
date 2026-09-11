import { describe, it, expect } from 'vitest';
import { createWebSearchTool } from '../../src/tools/web-search.js';
import { createWebFetchTool } from '../../src/tools/web-fetch.js';

describe('web_search', () => {
  it('has correct name and metadata', () => {
    const t = createWebSearchTool();
    expect(t.name).toBe('web_search');
    expect(t.permission).toEqual({ mode: 'auto' });
    expect((t.parameters.properties as any).query).toBeDefined();
  });
});

describe('web_fetch', () => {
  it('has correct name and metadata', () => {
    const t = createWebFetchTool();
    expect(t.name).toBe('web_fetch');
    expect(t.permission).toEqual({ mode: 'auto' });
    expect((t.parameters.properties as any).url).toBeDefined();
  });
});
