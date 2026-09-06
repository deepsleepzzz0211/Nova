import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import type { Tool, ToolContext, ToolResult } from './types.js';
import { proxyAwareFetch } from './proxy.js';

const TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 512 * 1024; // 500KB

function htmlToMarkdown(html: string, url: string): { title: string; content: string } {
  const dom = new JSDOM(html, { url });
  const document = dom.window.document;

  // Try Readability first for clean content extraction
  const reader = new Readability(document);
  const article = reader.parse();

  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

  if (article && article.content) {
    return {
      title: article.title ?? '',
      content: turndown.turndown(article.content),
    };
  }

  // Fallback: convert full HTML body
  const body = document.querySelector('body');
  const fallbackHtml = body ? body.innerHTML : html;
  return {
    title: document.title ?? '',
    content: turndown.turndown(fallbackHtml),
  };
}

export function createWebFetchTool(): Tool {
  return {
    name: 'web_fetch',
    description: 'Fetch a URL and extract its main content as Markdown. Useful for reading articles, documentation, and web pages.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
      },
      required: ['url'],
    },
    requiresPermission: () => false,
    async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
      const url = params.url as string;

      if (!url || !url.trim()) {
        return { content: 'Error: url is required.', isError: true };
      }

      // Basic URL validation
      try {
        new URL(url);
      } catch {
        return { content: `Invalid URL: ${url}`, isError: true };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const response = await proxyAwareFetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; Nova/1.0)',
            'Accept': 'text/html,application/xhtml+xml,*/*',
          },
        });

        if (!response.ok) {
          return {
            content: `Fetch failed with status ${response.status}: ${response.statusText}`,
            isError: true,
          };
        }

        // Enforce max response size
        const contentLength = response.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
          return {
            content: `Response too large (${(parseInt(contentLength, 10) / 1024).toFixed(0)}KB exceeds ${MAX_RESPONSE_BYTES / 1024}KB limit).`,
            isError: true,
          };
        }

        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > MAX_RESPONSE_BYTES) {
          return {
            content: `Response too large (${(arrayBuffer.byteLength / 1024).toFixed(0)}KB exceeds ${MAX_RESPONSE_BYTES / 1024}KB limit).`,
            isError: true,
          };
        }

        const html = new TextDecoder().decode(arrayBuffer);
        const { title, content } = htmlToMarkdown(html, url);

        const parts: string[] = [];
        if (title) {
          parts.push(`# ${title}`);
        }
        parts.push(content);

        return { content: parts.join('\n\n') };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('abort')) {
          return { content: `Fetch timed out after ${TIMEOUT_MS / 1000}s.`, isError: true };
        }
        return { content: `Fetch failed: ${message}`, isError: true };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
