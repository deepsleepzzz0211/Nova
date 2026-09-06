import { describe, it, expect, afterEach } from 'vitest';
import { createWebSearchTool, type SearchBackendOptions } from '../../src/tools/web-search.js';
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

function ddgHtml(count: number): string {
  const results = Array.from({ length: count }, (_, i) => `
    <a class="result__a" href="/l/?uddg=https%3A%2F%2Fddg.example%2F${i}">DDG Result ${i}</a>
    <a class="result__snippet" href="#">snippet ${i}</a>`).join('\n');
  return `<html><body>${results}</body></html>`;
}

describe('Tavily backend', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('posts to api.tavily.com/search with api key, query and max_results', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return tavilyResponse(3);
    }) as typeof fetch;

    const options: SearchBackendOptions = { provider: 'tavily', tavilyApiKey: 'tvly-test' };
    const result = await createWebSearchTool(options).execute({ query: 'test query', num_results: 3 }, ctx);

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

  it('falls back to DuckDuckGo when Tavily fails', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      if (String(url).includes('tavily')) {
        return { ok: false, status: 500, statusText: 'Server Error' } as unknown as Response;
      }
      return { ok: true, status: 200, text: async () => ddgHtml(2) } as unknown as Response;
    }) as typeof fetch;

    const options: SearchBackendOptions = { provider: 'tavily', tavilyApiKey: 'tvly-test' };
    const result = await createWebSearchTool(options).execute({ query: 'q' }, ctx);

    expect(urls.some((u) => u.includes('tavily'))).toBe(true);
    expect(urls.some((u) => u.includes('duckduckgo'))).toBe(true);
    expect(result.content).toContain('DDG Result 0');
  });

  it('uses DuckDuckGo first when provider is duckduckgo, falls back to Tavily', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      if (String(url).includes('duckduckgo')) {
        return { ok: false, status: 503 } as unknown as Response;
      }
      return tavilyResponse(2);
    }) as typeof fetch;

    const options: SearchBackendOptions = { provider: 'duckduckgo', tavilyApiKey: 'tvly-test' };
    const result = await createWebSearchTool(options).execute({ query: 'q' }, ctx);

    expect(urls[0]).toContain('duckduckgo');
    expect(urls[1]).toContain('tavily');
    expect(result.content).toContain('Tavily Result 0');
  });

  it('skips the Tavily backend entirely without an api key', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return { ok: true, status: 200, text: async () => ddgHtml(1) } as unknown as Response;
    }) as typeof fetch;

    const options: SearchBackendOptions = { provider: 'tavily' };
    const result = await createWebSearchTool(options).execute({ query: 'q' }, ctx);

    expect(urls.every((u) => u.includes('duckduckgo'))).toBe(true);
    expect(result.content).toContain('DDG Result 0');
  });

  it('reports failure when every backend fails', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 500 }) as unknown as Response) as typeof fetch;
    const options: SearchBackendOptions = { provider: 'tavily', tavilyApiKey: 'k' };
    const result = await createWebSearchTool(options).execute({ query: 'q' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('All search backends failed');
  });

  it('metadata stays cacheable and permission-free', () => {
    const tool = createWebSearchTool({ provider: 'tavily', tavilyApiKey: 'k' });
    expect(tool.metadata?.cacheable).toBe(true);
    expect(tool.requiresPermission?.({})).toBe(false);
  });
});
