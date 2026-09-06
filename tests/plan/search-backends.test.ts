import { describe, it, expect, afterEach } from 'vitest';
import { createWebSearchTool } from '../../src/tools/web-search.js';
import type { ToolContext } from '../../src/tools/types.js';

const originalFetch = globalThis.fetch;
const ctx: ToolContext = { workingDirectory: process.cwd(), abortSignal: new AbortController().signal };

function tavilyResponse(count: number): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      results: Array.from({ length: count }, (_, i) => ({
        title: `Tavily Result ${i}`,
        url: `https://tavily.example/${i}`,
        content: `Snippet <b>${i}</b> content`,
      })),
    }),
  } as unknown as Response;
}

describe('web_search (Tavily backend)', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('posts to api.tavily.com/search with api key, query and max_results', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return tavilyResponse(3);
    }) as typeof fetch;

    const result = await createWebSearchTool({ tavilyApiKey: 'tvly-test' }).execute(
      { query: 'test query', num_results: 3 },
      ctx,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.tavily.com/search');
    const body = JSON.parse(String(calls[0].init!.body));
    expect(body).toEqual({ api_key: 'tvly-test', query: 'test query', max_results: 3 });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('1. **Tavily Result 0**');
    expect(result.content).toContain('https://tavily.example/0');
    expect(result.content).toContain('Snippet 0 content'); // tags stripped
    expect(result.content).not.toContain('<b>');
  });

  it('requires an api key and names the setup steps when missing', async () => {
    const fetchSpy = async (): Promise<Response> => {
      throw new Error('must not be called');
    };
    globalThis.fetch = fetchSpy as typeof fetch;

    const result = await createWebSearchTool().execute({ query: 'q' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Tavily API key');
    expect(result.content).toContain('tavily_api_key');
    expect(result.content).toContain('TAVILY_API_KEY');
  });

  it('reports HTTP errors', async () => {
    globalThis.fetch = (async () =>
      ({ ok: false, status: 500, statusText: 'Server Error' }) as unknown as Response) as typeof fetch;
    const result = await createWebSearchTool({ tavilyApiKey: 'k' }).execute({ query: 'q' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('500');
  });

  it('requires a query', async () => {
    const result = await createWebSearchTool({ tavilyApiKey: 'k' }).execute({ query: '   ' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('query is required');
  });

  it('metadata stays cacheable and permission-free', () => {
    const tool = createWebSearchTool({ tavilyApiKey: 'k' });
    expect(tool.metadata?.cacheable).toBe(true);
    expect(tool.requiresPermission?.({})).toBe(false);
  });
});
