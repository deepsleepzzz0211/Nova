import type { Tool, ToolContext, ToolResult } from './types.js';
import { proxyAwareFetch } from './proxy.js';

const TIMEOUT_MS = 20_000;
const MAX_RESULTS = 10;
const DEFAULT_NUM_RESULTS = 5;

/** Recency windows accepted by the Tavily `time_range` parameter. */
const TIME_RANGES = ['day', 'week', 'month', 'year'] as const;
type TimeRange = (typeof TIME_RANGES)[number];

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'] as const;

/** Build the tool description; the clock is a parameter for deterministic tests. */
export function buildSearchDescription(now: Date = new Date()): string {
  const currentMonth = `${MONTH_NAMES[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
  return [
    'Search the web and return relevant results with titles, URLs, and snippets.',
    '',
    `- The current month is ${currentMonth} — use this when searching for recent information.`,
    '- Optional `time_range` (day/week/month/year) limits results to a recency window.',
    '- `include_domains` / `exclude_domains` filter by site; never specify both.',
    '- After answering from results, end with a "Sources:" list of the URLs you used as markdown links.',
  ].join('\n');
}

/** Validate an optional array-of-strings parameter. Returns an error message or null. */
function validateDomainList(name: string, value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.trim() === '')) {
    return `Error: ${name} must be an array of non-empty strings.`;
  }
  return null;
}

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

  async search(request: Record<string, unknown>): Promise<SearchResult[]> {
    const response = await httpPostJson(
      'https://api.tavily.com/search',
      JSON.stringify({ api_key: this.apiKey, ...request }),
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
      .slice(0, typeof request.max_results === 'number' ? request.max_results : MAX_RESULTS);
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
    description: buildSearchDescription(),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query string' },
        num_results: { type: 'number', description: 'Number of results to return (default: 5)' },
        time_range: {
          type: 'string',
          enum: [...TIME_RANGES],
          description: 'Recency window for the results (default: no limit)',
        },
        include_domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only return results from these domains (mutually exclusive with exclude_domains)',
        },
        exclude_domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Never return results from these domains (mutually exclusive with include_domains)',
        },
      },
      required: ['query'],
    },
    metadata: { category: 'web', cacheable: true, timeout: TIMEOUT_MS },
    permission: { mode: 'auto' },
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

      const timeRange = params.time_range as TimeRange | undefined;
      if (timeRange !== undefined && !TIME_RANGES.includes(timeRange)) {
        return {
          content: `Error: invalid time_range ${JSON.stringify(timeRange)} (expected one of: ${TIME_RANGES.join(', ')}).`,
          isError: true,
        };
      }

      const domainsError =
        validateDomainList('include_domains', params.include_domains) ??
        validateDomainList('exclude_domains', params.exclude_domains);
      if (domainsError) {
        return { content: domainsError, isError: true };
      }
      const includeDomains = params.include_domains as string[] | undefined;
      const excludeDomains = params.exclude_domains as string[] | undefined;
      if (includeDomains !== undefined && excludeDomains !== undefined) {
        return {
          content: 'Error: include_domains and exclude_domains cannot both be specified.',
          isError: true,
        };
      }

      const numResults = Math.min(
        Math.max(1, (params.num_results as number) || DEFAULT_NUM_RESULTS),
        MAX_RESULTS,
      );

      // Field order is fixed so the request body stays byte-identical when the
      // new params are absent (no spurious keys leak into the provider call).
      const body: Record<string, unknown> = { query, max_results: numResults };
      if (timeRange !== undefined) body.time_range = timeRange;
      // Provider quirk (proven against the live API): at basic depth Tavily
      // treats include/exclude_domains as a soft preference and leaks other
      // sites; only advanced depth enforces the filter. Escalate so the
      // parameter is honest, costing the extra credits domain precision is
      // worth.
      if (includeDomains?.length || excludeDomains?.length) body.search_depth = 'advanced';
      if (includeDomains?.length) body.include_domains = includeDomains;
      if (excludeDomains?.length) body.exclude_domains = excludeDomains;

      try {
        const results = await backend.search(body);
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
