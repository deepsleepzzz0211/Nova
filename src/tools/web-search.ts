import type { Tool, ToolContext, ToolResult } from './types.js';
import { proxyAwareFetch } from './proxy.js';

const TIMEOUT_MS = 20_000;
const MAX_RESULTS = 10;
const DEFAULT_NUM_RESULTS = 5;

/** Search backend options. */
export interface SearchBackendOptions {
  /** Tavily API key (free tier: tavily.com). Required. */
  tavilyApiKey?: string;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
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

/**
 * Tavily API backend (https://tavily.com — requires a free API key).
 * Structured results, reachable from CN networks, no scraping involved.
 */
class TavilyBackend {
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
 * web_search via the Tavily API. The backend was chosen deliberately:
 * free-tier structured search API that is reachable from CN networks
 * (SERP scraping backends like DuckDuckGo are unreachable there and were
 * removed). Additional backends (Brave/Exa/Serper) can plug in later.
 */
export function createWebSearchTool(options?: SearchBackendOptions): Tool {
  const backend = new TavilyBackend(options?.tavilyApiKey);

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

      if (!backend.reachable()) {
        return {
          content:
            'web_search requires a Tavily API key (free tier at tavily.com).\n' +
            'Set [search] tavily_api_key in config.toml or the TAVILY_API_KEY environment variable.',
          isError: true,
        };
      }

      const numResults = Math.min(
        Math.max(1, (params.num_results as number) || DEFAULT_NUM_RESULTS),
        MAX_RESULTS,
      );

      try {
        const results = await backend.search(query, numResults);
        return { content: formatResults(results) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('abort')) {
          return { content: `Search timed out after ${TIMEOUT_MS / 1000}s.`, isError: true };
        }
        return { content: `Search failed: ${message}`, isError: true };
      }
    },
  };
}
