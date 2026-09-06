import { describe, it, expect, afterEach } from 'vitest';
import { createWebFetchTool } from '../../src/tools/web-fetch.js';
import type { ToolContext } from '../../src/tools/types.js';

const originalFetch = globalThis.fetch;
const ctx: ToolContext = { workingDirectory: process.cwd(), abortSignal: new AbortController().signal };

function ddgHtml(count: number): string {
  const results = Array.from({ length: count }, (_, i) => `
    <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fpage${i}">Result ${i}</a>
    <a class="result__snippet" href="#">Snippet <b>${i}</b></a>`).join('\n');
  return `<html><body><div>${results}</div></body></html>`;
}

describe('web_fetch (mocked fetch)', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const tool = createWebFetchTool();

  it('requires a url', async () => {
    const result = await tool.execute({ url: '  ' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('url is required');
  });

  it('rejects invalid urls', async () => {
    const result = await tool.execute({ url: 'not-a-url' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid URL');
  });

  it('extracts article content as markdown with the title', async () => {
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': '200' }),
        arrayBuffer: async () =>
          new TextEncoder().encode(
            '<html><head><title>Doc Title</title></head><body><article><h1>Big Heading</h1><p>Body text here.</p></article></body></html>',
          ).buffer,
      }) as unknown as Response) as typeof fetch;

    const result = await tool.execute({ url: 'https://example.com/doc' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('# Doc Title');
    expect(result.content).toContain('Big Heading');
    expect(result.content).toContain('Body text here');
  });

  it('reports non-ok statuses', async () => {
    globalThis.fetch = (async () =>
      ({ ok: false, status: 404, statusText: 'Not Found' }) as unknown as Response) as typeof fetch;
    const result = await tool.execute({ url: 'https://example.com/x' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('404');
  });

  it('enforces the content-length size limit', async () => {
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': String(1024 * 1024) }),
        arrayBuffer: async () => new ArrayBuffer(10),
      }) as unknown as Response) as typeof fetch;
    const result = await tool.execute({ url: 'https://example.com/big' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Response too large');
    expect(result.content).toContain('exceeds');
  });

  it('wraps fetch exceptions', async () => {
    globalThis.fetch = (async () => {
      throw new Error('connection refused');
    }) as typeof fetch;
    const result = await tool.execute({ url: 'https://example.com/x' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('connection refused');
  });
});
