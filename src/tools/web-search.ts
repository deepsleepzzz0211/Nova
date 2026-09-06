import type { Tool, ToolContext, ToolResult } from './types.js';
import { proxyAwareFetch } from './proxy.js';

const TIMEOUT_MS = 20_000;
const MAX_RESULTS = 10;
const DEFAULT_NUM_RESULTS = 5;

/** Search backend selection (from config.search). */
export interface SearchBackendOptions {
  /** Preferred backend; the other one is the fallback. Default 'duckduckgo'. */
  provider?: 'tavily' | 'duckduckgo';
  /** Tavily API key. The Tavily backend is skipped when absent. */
  tavilyApiKey?: string;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface SearchBackend {
  name: string;
  reachable(): boolean;
  search(query: string, numResults: number): Promise<SearchResult[]>;
}

async function httpPostJson(url: string, body: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await proxyAwareFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Tavily API backend (https://tavily.com — requires an API key). */
class TavilyBackend implements SearchBackend {
  name = 'tavily';

  constructor(private readonly apiKey?: string) {}

  reachable(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0;
  }

  async search(query: string, numResults: number): Promise<SearchResult[]> {
    const response = await httpPostJson(
      'https://api.tavily.com/search',
      JSON.stringify({ api_key: this.apiKey, query, max_results: numResults }),
      TIMEOUT_MS,
    );

    if (!response.ok) {
      throw new Error(`Tavily request failed with status ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };

    return (data.results ?? [])
      .filter((r) => r.url)
      .map((r) => ({
        title: (r.title ?? '').replace(/<[^>]*>/g, '').trim(),
        url: r.url!,
        snippet: (r.content ?? '').replace(/<[^>]*>/g, '').trim(),
      }))
      .slice(0, numResults);
  }
}

/** DuckDuckGo HTML backend (no API key; often unreachable in some networks). */
class DuckDuckGoBackend implements SearchBackend {
  name = 'duckduckgo';

  reachable(): boolean {
    return true;
  }

  async search(query: string, numResults: number): Promise<SearchResult[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await proxyAwareFetch('https://html.duckduckgo.com/html/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ q: query }).toString(),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Search request failed with status ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();
      return DuckDuckGoBackend.parseSearchResults(html, numResults);
    } finally {
      clearTimeout(timer);
    }
  }

  static parseSearchResults(html: string, maxResults: number): SearchResult[] {
    const results: SearchResult[] = [];

    // Match result blocks: each result has result__a for title/url and result__snippet for description
    const resultBlockRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

    let match: RegExpExecArray | null;
    while ((match = resultBlockRegex.exec(html)) !== null && results.length < maxResults) {
      const rawUrl = match[1];
      const rawTitle = match[2];
      const rawSnippet = match[3];

      // DuckDuckGo wraps URLs in a redirect; extract the actual URL from the uddg param
      const urlMatch = /[?&]uddg=([^&]+)/.exec(rawUrl);
      const url = urlMatch ? decodeURIComponent(urlMatch[1]) : rawUrl;

      // Strip HTML tags from title and snippet
      const title = rawTitle.replace(/<[^>]*>/g, '').trim();
      const snippet = rawSnippet.replace(/<[^>]*>/g, '').trim();

      if (title && url) {
        results.push({ title, url, snippet });
      }
    }

    return results;
  }
}

function formatResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return 'No results found.';
  }

  return results
    .map((r, i) => {
      const parts = [`${i + 1}. **${r.title}**`];
      parts.push(`   URL: ${r.url}`);
      if (r.snippet) {
        parts.push(`   ${r.snippet}`);
      }
      return parts.join('\n');
    })
    .join('\n\n');
}

/**
 * web_search with a backend chain: preferred backend first (config.search
 * .provider), the other backend as fallback. Tavily requires an API key
 * and is skipped when absent.
 */
export function createWebSearchTool(options?: SearchBackendOptions): Tool {
  const preferred = options?.provider ?? 'duckduckgo';
  const backends: SearchBackend[] = [
    new TavilyBackend(options?.tavilyApiKey),
    new DuckDuckGoBackend(),
  ].sort((a) => (a.name === preferred ? -1 : 1));

  return {
    name: 'web_search',
    description: 'Search the web and return relevant results with titles, URLs, and snippets.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query string' },
        num_results: { type: 'number', description: 'Number of results to return (default: 5)' },
      },
      required: ['query'],
    },
    metadata: { category: 'web', cacheable: true, timeout: TIMEOUT_MS },
    requiresPermission: () => false,
    async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
      const query = params.query as string;

      if (!query || !query.trim()) {
        return { content: 'Error: query is required.', isError: true };
      }

      const numResults = Math.min(
        Math.max(1, (params.num_results as number) || DEFAULT_NUM_RESULTS),
        MAX_RESULTS,
      );

      const errors: string[] = [];
      for (const backend of backends) {
        if (!backend.reachable()) {
          errors.push(`${backend.name}: no API key`);
          continue;
        }
        try {
          const results = await backend.search(query, numResults);
          return { content: formatResults(results) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(`${backend.name}: ${message}`);
        }
      }

      return { content: `All search backends failed.\n${errors.map((e) => `- ${e}`).join('\n')}`, isError: true };
    },
  };
}
