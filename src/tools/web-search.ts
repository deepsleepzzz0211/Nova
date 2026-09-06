import type { Tool, ToolContext, ToolResult } from './types.js';

const TIMEOUT_MS = 20_000;
const MAX_RESULTS = 10;
const DEFAULT_NUM_RESULTS = 5;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function parseSearchResults(html: string, maxResults: number): SearchResult[] {
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

export function createWebSearchTool(): Tool {
  return {
    name: 'web_search',
    description: 'Search the web using DuckDuckGo and return relevant results with titles, URLs, and snippets.',
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

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const body = new URLSearchParams({ q: query });
        const response = await fetch('https://html.duckduckgo.com/html/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          signal: controller.signal,
        });

        if (!response.ok) {
          return {
            content: `Search request failed with status ${response.status}: ${response.statusText}`,
            isError: true,
          };
        }

        const html = await response.text();
        const results = parseSearchResults(html, numResults);
        const formatted = formatResults(results);

        return { content: formatted };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('abort')) {
          return { content: `Search timed out after ${TIMEOUT_MS / 1000}s.`, isError: true };
        }
        return { content: `Search failed: ${message}`, isError: true };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
