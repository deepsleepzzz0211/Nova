import { marked, type Tokens } from 'marked';

/**
 * Markdown parsing + syntax-highlight helpers for Ink rendering
 * (tui-refactor ticket 07). Pure: no Ink/React here, so streaming-input
 * tolerance and the render cache are unit-testable.
 */

export interface MdBlock {
  kind: 'heading' | 'paragraph' | 'list' | 'code' | 'quote' | 'table';
  /** Plain text content (code: raw source; heading/paragraph/quote: text).
   * Lists and tables carry their content in `items` / `rows` instead. */
  text: string;
  /** Heading level (1-6). */
  level?: number;
  /** List items (plain text, may contain inline markers). */
  items?: string[];
  /** Whether a list is ordered. */
  ordered?: boolean;
  /** Fence language for code blocks. */
  language?: string | null;
  /** Table rows (first row = header). */
  rows?: string[][];
}

/** Normalize a fence info string to a highlight.js language hint. */
export function languageOf(info: string): string | null {
  const trimmed = info.trim().split(/\s+/)[0];
  return trimmed === '' ? null : trimmed;
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
        const body = inner
          .map((t) => ('text' in t ? String((t as { text?: string }).text ?? '') : ''))
          .filter((s) => s !== '')
          .join('\n');
        blocks.push({ kind: 'quote', text: body });
        break;
      }
      case 'list': {
        const list = token as Tokens.List;
        const items = list.items.map((item) =>
          item.tokens
            .map((t) => ('text' in t ? String((t as { text?: string }).text ?? '') : ''))
            .join(' ')
            .trim(),
        );
        blocks.push({ kind: 'list', text: '', ordered: list.ordered === true, items });
        break;
      }
      case 'table': {
        const table = token as Tokens.Table;
        const rows = [
          table.header.map((cell) => cell.text),
          ...table.rows.map((row) => row.map((cell) => cell.text)),
        ];
        blocks.push({ kind: 'table', text: '', rows });
        break;
      }
      case 'space':
        // Blank lines carry no display content; the renderer uses spacing.
        break;
      default:
        if ('text' in token && typeof (token as unknown as { text?: unknown }).text === 'string') {
          blocks.push({
            kind: 'paragraph',
            text: String((token as unknown as { text: string }).text),
          });
        }
    }
  }
  return blocks;
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
};

/** Decode the HTML entities hljs emits in its highlighter output. */
function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);
}

/**
 * Parse highlight.js HTML output into plain segments with class names, so
 * the Ink layer can map classes to terminal colors.
 */
export function highlightToSegments(html: string): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  const pattern = /<span class="([^"]+)">([\s\S]*?)<\/span>/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    if (match.index > last) {
      segments.push({ text: decodeEntities(html.slice(last, match.index)), className: null });
    }
    segments.push({
      text: decodeEntities(match[2].replace(/<[^>]+>/g, '')),
      className: match[1],
    });
    last = pattern.lastIndex;
  }
  if (last < html.length) {
    segments.push({ text: decodeEntities(html.slice(last)), className: null });
  }
  return segments;
}

/** Render cache cap (long sessions keep re-rendering the same messages). */
const CACHE_CAP = 200;
const blockCache = new Map<string, MdBlock[]>();

/** Cached parse: identical text returns the identical array (memoised). */
export function getCachedBlocks(text: string): MdBlock[] {
  const hit = blockCache.get(text);
  if (hit !== undefined) return hit;
  const blocks = parseMarkdownBlocks(text);
  blockCache.set(text, blocks);
  if (blockCache.size > CACHE_CAP) {
    const oldest = blockCache.keys().next().value;
    if (oldest !== undefined) blockCache.delete(oldest);
  }
  return blocks;
}

/** Test/theme hook: drop all cached renders. */
export function clearBlockCache(): void {
  blockCache.clear();
}
