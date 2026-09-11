import { marked, type Tokens } from 'marked';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

// Only the languages we render are registered: highlightAuto (unknown
// fences) then scans a short list instead of the full ~190-language build.
for (const [name, def] of Object.entries({
  bash,
  css,
  go,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
})) {
  hljs.registerLanguage(name, def as never);
}

/**
 * Markdown parsing + syntax-highlight helpers for Ink rendering
 * (tui-refactor ticket 07). Pure: no Ink/React here, so streaming-input
 * tolerance, highlighting and the render caches are unit-testable.
 */

export interface MdBlock {
  kind: 'heading' | 'paragraph' | 'list' | 'code' | 'quote' | 'table' | 'rule';
  /** Plain text content (code: raw source; heading/paragraph/quote: text).
   * Lists and tables carry their content in `items` / `rows` instead. */
  text: string;
  /** Heading level (1-6). */
  level?: number;
  /** List items (plain text, may contain inline markers). */
  items?: string[];
  /** Whether a list is ordered. */
  ordered?: boolean;
  /** First number of an ordered list. */
  start?: number;
  /** Fence language for code blocks. */
  language?: string | null;
  /** Table rows (first row = header), column-padded for display. */
  rows?: string[][];
}

/** Normalize a fence info string to a highlight.js language hint. */
export function languageOf(info: string): string | null {
  const trimmed = info.trim().split(/\s+/)[0];
  return trimmed === '' ? null : trimmed;
}

/** Recursively collect the plain text of a token list (nested lists kept). */
interface MinimalToken {
  type?: string;
  text?: string;
  tokens?: MinimalToken[];
  items?: Array<{ tokens?: MinimalToken[] }>;
}

function textOfTokens(tokens: MinimalToken[] | undefined): string {
  if (tokens === undefined) return '';
  const parts: string[] = [];
  const push = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed !== '' && !parts.includes(trimmed)) parts.push(trimmed);
  };
  for (const token of tokens) {
    if (typeof token.text === 'string') push(token.text);
    // Nested lists carry their children in `items`, other containers in
    // `tokens` (leaf tokens already contributed their `text` above).
    if (Array.isArray(token.items)) {
      for (const item of token.items) push(textOfTokens(item.tokens));
    } else if (Array.isArray(token.tokens) && token.type !== 'text') {
      push(textOfTokens(token.tokens));
    }
  }
  return parts.join(' ').trim();
}

/** Marked lexer tokens → normalized blocks (streaming-tolerant). */
export function parseMarkdownBlocks(text: string): MdBlock[] {
  let tokens: Tokens.Generic[];
  try {
    tokens = marked.lexer(text) as unknown as Tokens.Generic[];
  } catch {
    // Never let malformed partial input break the UI
    return [{ kind: 'paragraph', text }];
  }

  const blocks: MdBlock[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'heading':
        blocks.push({
          kind: 'heading',
          level: (token as Tokens.Heading).depth,
          text: (token as Tokens.Heading).text,
        });
        break;
      case 'paragraph':
        blocks.push({ kind: 'paragraph', text: (token as Tokens.Paragraph).text });
        break;
      case 'code':
        blocks.push({
          kind: 'code',
          text: (token as Tokens.Code).text,
          language: languageOf((token as Tokens.Code).lang ?? ''),
        });
        break;
      case 'blockquote': {
        const inner = (token as Tokens.Blockquote).tokens ?? [];
        blocks.push({
          kind: 'quote',
          text: textOfTokens(inner as MinimalToken[]),
        });
        break;
      }
      case 'list': {
        const list = token as Tokens.List;
        const items = list.items.map((item) =>
          textOfTokens(item.tokens as MinimalToken[]),
        );
        blocks.push({
          kind: 'list',
          text: '',
          ordered: list.ordered === true,
          start: typeof list.start === 'number' ? list.start : 1,
          items,
        });
        break;
      }
      case 'table': {
        const table = token as Tokens.Table;
        const rows = [
          table.header.map((cell) => cell.text),
          ...table.rows.map((row) => row.map((cell) => cell.text)),
        ];
        blocks.push({ kind: 'table', text: '', rows: padColumns(rows) });
        break;
      }
      case 'hr':
        blocks.push({ kind: 'rule', text: '' });
        break;
      case 'space':
        // Blank lines carry no display content; the renderer uses spacing.
        break;
      default:
        if (
          'text' in token &&
          typeof (token as unknown as { text?: unknown }).text === 'string' &&
          (token as unknown as { text: string }).text !== ''
        ) {
          blocks.push({
            kind: 'paragraph',
            text: String((token as unknown as { text: string }).text),
          });
        }
    }
  }
  return blocks;
}

/** Pad table cells so columns line up when joined with ' | '. */
function padColumns(rows: string[][]): string[][] {
  const width = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: width }, (_, c) =>
    Math.max(...rows.map((r) => (r[c] ?? '').length)),
  );
  return rows.map((row) => widths.map((w, c) => (row[c] ?? '').padEnd(w)));
}

/** Inline markdown markers stripped to plain text for terminal display. */
export function inlineText(raw: string): string {
  return raw
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\s)\*([^*]+)\*/g, '$1$2')
    .replace(/(^|\s)_([^_]+)_/g, '$1$2')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '');
}

/** hljs class name → terminal color (theme tokens arrive with ticket 11). */
export function highlightColor(className: string | null): string | undefined {
  if (className === null) return undefined;
  const rules: Array<{ match: RegExp; color: string }> = [
    { match: /keyword|built_in|literal|type|class/, color: 'magenta' },
    { match: /string|regexp|char/, color: 'green' },
    { match: /comment|quote/, color: 'gray' },
    { match: /number|attr|variable/, color: 'yellow' },
    { match: /title|function|name/, color: 'cyan' },
  ];
  return rules.find((rule) => rule.match.test(className))?.color;
}

export interface HighlightSegment {
  text: string;
  /** hljs class name (e.g. 'hljs-keyword'), or null for plain text. */
  className: string | null;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
};

/** Decode the HTML entities hljs emits (named + numeric). */
function decodeEntities(text: string): string {
  return text.replace(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi, (m) => {
    const named = ENTITIES[m.toLowerCase()];
    if (named !== undefined) return named;
    const hex = /^&#x([0-9a-f]+);$/i.exec(m);
    if (hex !== null) return String.fromCodePoint(Number.parseInt(hex[1], 16));
    const dec = /^&#(\d+);$/.exec(m);
    if (dec !== null) return String.fromCodePoint(Number.parseInt(dec[1], 10));
    return m;
  });
}

/**
 * Parse highlight.js HTML into segments with class names, so the Ink layer
 * can map classes to terminal colors.
 *
 * Stack-based on purpose: hljs nests spans and its spans may contain
 * newlines, so a flat regex would leave stray tags or lose colors across
 * lines (review findings 5 and 6). Segments may contain '\n'.
 */
export function highlightToSegments(html: string): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  const stack: Array<string | null> = [];
  let buffer = '';
  let i = 0;

  const flush = (): void => {
    if (buffer !== '') {
      segments.push({ text: decodeEntities(buffer), className: stack[stack.length - 1] ?? null });
      buffer = '';
    }
  };

  while (i < html.length) {
    if (html.startsWith('<span class="', i)) {
      const end = html.indexOf('">', i);
      if (end === -1) {
        buffer += html.slice(i);
        break;
      }
      flush();
      stack.push(html.slice(i + 13, end));
      i = end + 2;
      continue;
    }
    if (html.startsWith('</span>', i)) {
      flush();
      stack.pop();
      i += 7;
      continue;
    }
    if (html[i] === '<') {
      // Any other tag (br etc.) is dropped from the text stream.
      const end = html.indexOf('>', i);
      if (end === -1) {
        buffer += html.slice(i);
        break;
      }
      i = end + 1;
      continue;
    }
    buffer += html[i];
    i++;
  }
  flush();
  return segments;
}

/** Highlighted lines of a code block, memoised by (language, code). */
const highlightCache = new Map<string, HighlightSegment[][]>();
const HIGHLIGHT_CACHE_CAP = 300;

export function highlightedLines(code: string, language: string | null): HighlightSegment[][] {
  const key = `${language ?? ''}\u0000${code}`;
  const hit = highlightCache.get(key);
  if (hit !== undefined) {
    // LRU touch
    highlightCache.delete(key);
    highlightCache.set(key, hit);
    return hit;
  }

  let html: string;
  try {
    if (language !== null && hljs.getLanguage(language)) {
      html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
    } else {
      html = hljs.highlightAuto(code).value;
    }
  } catch {
    html = code;
  }

  // Split the whole document's segments into display lines, keeping each
  // line's colors intact.
  const lines: HighlightSegment[][] = [[]];
  for (const segment of highlightToSegments(html)) {
    const parts = segment.text.split('\n');
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part !== '') lines[lines.length - 1].push({ text: part, className: segment.className });
    });
  }

  highlightCache.set(key, lines);
  if (highlightCache.size > HIGHLIGHT_CACHE_CAP) {
    const oldest = highlightCache.keys().next().value;
    if (oldest !== undefined) highlightCache.delete(oldest);
  }
  return lines;
}

/** Render cache cap (long sessions keep re-rendering the same messages). */
const CACHE_CAP = 200;
/** Total cached source characters; streaming deltas would otherwise retain
 * up to CACHE_CAP full message copies. */
const CACHE_CHAR_BUDGET = 512 * 1024;
const blockCache = new Map<string, MdBlock[]>();
let cachedChars = 0;

/** Cached parse: identical text returns the identical array (memoised). */
export function getCachedBlocks(text: string): MdBlock[] {
  const hit = blockCache.get(text);
  if (hit !== undefined) {
    // LRU touch
    blockCache.delete(text);
    blockCache.set(text, hit);
    return hit;
  }
  const blocks = parseMarkdownBlocks(text);
  blockCache.set(text, blocks);
  cachedChars += text.length;
  while (blockCache.size > CACHE_CAP || (cachedChars > CACHE_CHAR_BUDGET && blockCache.size > 1)) {
    const oldest = blockCache.keys().next().value;
    if (oldest === undefined) break;
    blockCache.delete(oldest);
    cachedChars -= oldest.length;
  }
  return blocks;
}

/** Test/theme hook: drop all cached renders. */
export function clearBlockCache(): void {
  blockCache.clear();
  highlightCache.clear();
  cachedChars = 0;
}
