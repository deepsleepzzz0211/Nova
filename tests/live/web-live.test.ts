/**
 * LIVE network tests for the web research tools.
 * Real HTTP requests — no mocks. Run with:
 *   pnpm test:live
 *
 * web_search tests require a Tavily API key (free tier: tavily.com):
 *   set TAVILY_API_KEY in the environment, or [search] tavily_api_key in
 *   config.toml. Without a key — or on networks that block the backend —
 *   the search tests are skipped, since results depend on external
 *   services. web_fetch tests run unconditionally.
 */
import { describe, it, expect } from 'vitest';
import { createWebSearchTool } from '../../src/tools/web-search.js';
import { createWebFetchTool } from '../../src/tools/web-fetch.js';
import { ToolExecutionPipeline } from '../../src/tools/execution-pipeline.js';
import { ToolResultCache } from '../../src/cache/tool-result-cache.js';
import { PermissionPolicy } from '../../src/permission/policy.js';
import type { ToolContext } from '../../src/tools/types.js';

const policy = new PermissionPolicy({
  autoApproveFileWrite: false,
  autoApproveBash: false,
  alwaysAllowCommands: [],
});

function makePipeline(): ToolExecutionPipeline {
  return new ToolExecutionPipeline(new ToolResultCache(), policy);
}

const ctx: ToolContext = { workingDirectory: process.cwd(), abortSignal: new AbortController().signal };
const tavilyKey = process.env.TAVILY_API_KEY;
const hasSearchKey = typeof tavilyKey === 'string' && tavilyKey.length > 0;

describe.skipIf(!hasSearchKey)('LIVE web_search (Tavily backend)', () => {
  const tool = createWebSearchTool({ provider: 'tavily', tavilyApiKey: tavilyKey });

  it('searches an English query and returns formatted results', async () => {
    const result = await tool.execute({ query: 'vitest testing framework', num_results: 5 }, ctx);
    console.log('--- web_search EN ---\n' + result.content.slice(0, 800));
    expect(result.isError).toBeUndefined();
    expect(result.content).toMatch(/\d+\. \*\*.+\*\*/);
    expect(result.content).toContain('URL: https://');
  });

  it('searches a Chinese query', async () => {
    const result = await tool.execute({ query: 'TypeScript 编译器 配置', num_results: 5 }, ctx);
    console.log('--- web_search ZH ---\n' + result.content.slice(0, 800));
    expect(result.isError).toBeUndefined();
    expect(result.content).toMatch(/\d+\. \*\*.+\*\*/);
  });

  it('honors num_results=3', async () => {
    const result = await tool.execute({ query: 'openai api', num_results: 3 }, ctx);
    const numbered = (result.content.match(/^\d+\. /gm) ?? []).length;
    console.log(`--- web_search num_results=3 → got ${numbered} ---`);
    expect(numbered).toBe(3);
  });

  it('caches identical queries at the pipeline level (2nd call = cache hit)', async () => {
    const pipeline = makePipeline();
    const params = { query: 'prompt caching llm', num_results: 3 };
    const t0 = Date.now();
    const first = await pipeline.execute(tool, params, ctx);
    const t1 = Date.now();
    const second = await pipeline.execute(tool, params, ctx);
    const t2 = Date.now();
    console.log(`--- web_search cache --- first ${t1 - t0}ms, cached ${t2 - t1}ms`);
    expect(second.content).toBe(first.content);
    expect(second.isError).toBeUndefined();
    expect(t2 - t1).toBeLessThan(t1 - t0);
  });
});

describe('LIVE web_fetch (Readability → Markdown)', () => {
  const tool = createWebFetchTool();

  it('fetches example.com and extracts content', async () => {
    const result = await tool.execute({ url: 'https://example.com' }, ctx);
    console.log('--- web_fetch example.com ---\n' + result.content.slice(0, 500));
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('Example Domain');
  });

  it('fetches a documentation page (developer.mozilla.org)', async () => {
    const result = await tool.execute({ url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status' }, ctx);
    console.log('--- web_fetch MDN ---\n' + result.content.slice(0, 600));
    expect(result.isError).toBeUndefined();
    expect(result.content.length).toBeGreaterThan(200);
    expect(result.content).toContain('HTTP');
  });

  it('reports 404s as errors', async () => {
    const result = await tool.execute({ url: 'https://example.com/definitely-not-a-page-404-check' }, ctx);
    console.log('--- web_fetch 404 ---\n' + result.content);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('404');
  });

  it('rejects invalid urls without network access', async () => {
    const result = await tool.execute({ url: 'not-a-url' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid URL');
  });

  it('reports DNS failures as errors', async () => {
    const result = await tool.execute({ url: 'https://this-domain-does-not-exist-nova-test.invalid' }, ctx);
    console.log('--- web_fetch dns ---\n' + result.content);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Fetch failed');
  });
});
