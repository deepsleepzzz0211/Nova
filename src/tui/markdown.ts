import { marked, type Tokens } from 'marked';
import { theme } from './theme.js';
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
import { displayWidth, padToWidth } from './text-measure.js';

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

export type MdBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: string[] }
  | { kind: 'code'; text: string; language: string | null }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'rule' };

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
    const own = typeof token.text === 'string' ? token.text.trim() : '';
    if (own !== '') {
      // token.text is the RAW source of this token's inline children —
      // descending into .tokens here used to duplicate the content
      // (md-structured-inline 04 acceptance).
      push(own);
      continue;
    }
    // Nested lists carry their children in `items`, other containers in
    // `tokens` (only when the container itself has no text).
    if (Array.isArray(token.items)) {
      for (const item of token.items) push(textOfTokens(item.tokens));
    } else if (Array.isArray(token.tokens)) {
      push(textOfTokens(token.tokens));
    }
  }
  return parts.join(' ').trim();
}

/** Marked lexer tokens → normalized blocks (streaming-tolerant). */
export function parseMarkdownBlocks(text: string): MdBlock[] {
  return parseBlocksWithRaw(text).blocks;
}

/**
 * Same parse, additionally reporting how many source characters the tokens
 * consumed (block tokens carry their raw text). The streaming cache uses
 * `rawLen` to cut the reuse boundary and `blocks` to render (03).
 */
export function parseBlocksWithRaw(text: string): { blocks: MdBlock[]; rawLen: number } {
  let tokens: Tokens.Generic[];
  try {
    tokens = marked.lexer(text) as unknown as Tokens.Generic[];
  } catch {
    // Never let malformed partial input break the UI
    return { blocks: [{ kind: 'paragraph', text }], rawLen: text.length };
  }

  const blocks: MdBlock[] = [];
  let rawLen = 0;
  for (const token of tokens) {
    rawLen += typeof token.raw === 'string' ? token.raw.length : 0;
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
        blocks.push({ kind: 'table', rows: padColumns(rows) });
        break;
      }
      case 'hr':
        blocks.push({ kind: 'rule' });
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
  return { blocks, rawLen };
}

/** Pad table cells so columns line up when joined with ' | '. */
function padColumns(rows: string[][]): string[][] {
  const width = Math.max(...rows.map((r) => r.length));
  // Measure TERMINAL COLUMNS, not code units, so CJK/emoji cells align.
  const widths = Array.from({ length: width }, (_, c) =>
    Math.max(...rows.map((r) => displayWidth(r[c] ?? ''))),
  );
  return rows.map((row) => widths.map((w, c) => padToWidth(row[c] ?? '', w)));
}

/** Inline marker stripping + code-span parts live in markdown-inline.js
 * (tui-redesign 07); re-exported so existing imports keep working. */
export { inlineText, inlineParts, parseInlineNodes, INLINE_STYLE, flattenInline, type InlinePart, type InlineNode, type InlineStyle } from './markdown-inline.js';

/** hljs class name → terminal color (theme.syntax, tui-redesign 01). */
export function highlightColor(className: string | null): string | undefined {
  if (className === null) return undefined;
  const rules: Array<{ match: RegExp; color: string }> = [
    { match: /keyword|built_in|literal|type|class/, color: theme.syntax.keyword },
    { match: /string|regexp|char/, color: theme.syntax.string },
    { match: /comment|quote/, color: theme.syntax.comment },
    { match: /number|attr|variable/, color: theme.syntax.number },
    { match: /title|function|name/, color: theme.syntax.title },
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

/** Drop the highlight memo (the block cache lives in markdown-cache.js and
 * calls this from its own clear — md-structured-inline 03 split). */
export function clearHighlightCache(): void {
  highlightCache.clear();
}
