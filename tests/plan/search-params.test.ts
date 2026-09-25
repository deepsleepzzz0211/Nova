import { describe, it, expect, afterEach } from 'vitest';
import { createWebSearchTool, buildSearchDescription } from '../../src/tools/web-search.js';
import type { ToolContext } from '../../src/tools/types.js';

// web-search-batch ticket 01: time_range / domain filters / description
// engineering (month anchor + Sources convention).

const originalFetch = globalThis.fetch;
const ctx: ToolContext = { workingDirectory: process.cwd(), abortSignal: new AbortController().signal };

function tavilyResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ results: [] }),
  } as unknown as Response;
}

function captureFetch(): { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return tavilyResponse();
  }) as unknown as typeof fetch;
  return { calls };
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'] as const;

describe('web_search parameter surface (ticket 01)', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('request body with no new params stays exactly the legacy shape', async () => {
    const { calls } = captureFetch();
    await createWebSearchTool({ tavilyApiKey: 'tvly-test' }).execute({ query: 'q' }, ctx);
    expect(calls).toEqual([{ api_key: 'tvly-test', query: 'q', max_results: 5 }]);
  });

  it('legacy request body is byte-identical JSON, key order included', async () => {
    let raw = '';
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      raw = String(init?.body);
      return tavilyResponse();
    }) as unknown as typeof fetch;
    await createWebSearchTool({ tavilyApiKey: 'tvly-test' }).execute({ query: 'q' }, ctx);
    expect(raw).toBe('{"api_key":"tvly-test","query":"q","max_results":5}');
  });

  it('both filter keys present is an error even when one list is empty', async () => {
    const { calls } = captureFetch();
    const r = await createWebSearchTool({ tavilyApiKey: 'tvly-test' })
      .execute({ query: 'q', include_domains: [], exclude_domains: ['a.com'] }, ctx);
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('time_range passes through verbatim', async () => {
    const { calls } = captureFetch();
    const r = await createWebSearchTool({ tavilyApiKey: 'tvly-test' })
      .execute({ query: 'q', time_range: 'week' }, ctx);
    expect(r.isError).toBeUndefined();
    expect(calls[0]).toEqual({ api_key: 'tvly-test', query: 'q', max_results: 5, time_range: 'week' });
  });

  it('rejects a time_range outside the enum without sending a request', async () => {
    const { calls } = captureFetch();
    const r = await createWebSearchTool({ tavilyApiKey: 'tvly-test' })
      .execute({ query: 'q', time_range: 'decade' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('time_range');
    expect(calls).toHaveLength(0);
  });

  it('include_domains and exclude_domains pass through with the hard-filter depth', async () => {
    const { calls } = captureFetch();
    await createWebSearchTool({ tavilyApiKey: 'tvly-test' })
      .execute({ query: 'q', include_domains: ['docs.python.org'] }, ctx);
    expect(calls[0]).toEqual({
      api_key: 'tvly-test', query: 'q', max_results: 5,
      search_depth: 'advanced', include_domains: ['docs.python.org'],
    });

    calls.length = 0;
    await createWebSearchTool({ tavilyApiKey: 'tvly-test' })
      .execute({ query: 'q', exclude_domains: ['forum.example.com'] }, ctx);
    expect(calls[0]).toEqual({
      api_key: 'tvly-test', query: 'q', max_results: 5,
      search_depth: 'advanced', exclude_domains: ['forum.example.com'],
    });
  });

  it('include_domains and exclude_domains together is a mutual-exclusion error, unsent', async () => {
    const { calls } = captureFetch();
    const r = await createWebSearchTool({ tavilyApiKey: 'tvly-test' })
      .execute({ query: 'q', include_domains: ['a.com'], exclude_domains: ['b.com'] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/cannot both|mutually exclusive|both specified/i);
    expect(calls).toHaveLength(0);
  });

  it('domain filters must be arrays of strings; anything else is rejected unsent', async () => {
    const { calls } = captureFetch();
    const tool = createWebSearchTool({ tavilyApiKey: 'tvly-test' });
    const r1 = await tool.execute({ query: 'q', include_domains: 'a.com' }, ctx);
    expect(r1.isError).toBe(true);
    const r2 = await tool.execute({ query: 'q', include_domains: [42] }, ctx);
    expect(r2.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('tool description carries the current-month anchor and the Sources convention', () => {
    const pinned = buildSearchDescription(new Date(Date.UTC(2026, 8, 25)));
    expect(pinned).toContain('The current month is September 2026');
    expect(pinned).toContain('Sources:');
    expect(pinned).toContain('time_range');
    expect(createWebSearchTool({ tavilyApiKey: 'tvly-test' }).description).toContain(
      `The current month is ${MONTH_NAMES[new Date().getUTCMonth()]} ${new Date().getUTCFullYear()}`,
    );
  });

  it('JSON schema advertises the new parameters and keeps query the only required field', () => {
    const tool = createWebSearchTool({ tavilyApiKey: 'tvly-test' });
    const props = tool.parameters.properties as Record<string, { type?: string; enum?: string[] }>;
    expect(props.time_range?.type).toBe('string');
    expect(props.time_range?.enum).toEqual(['day', 'week', 'month', 'year']);
    expect(props.include_domains?.type).toBe('array');
    expect(props.exclude_domains?.type).toBe('array');
    expect(tool.parameters.required).toEqual(['query']);
  });
});
