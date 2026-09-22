/**
 * Inline markdown handling for the terminal renderer (md-structured-inline):
 * ONE CommonMark path — parseInlineNodes builds a node tree from marked's
 * inline lexer, and the renderer styles nodes via INLINE_STYLE. The old
 * regex marker-stripper (inlineText/inlineParts) is gone: it leaked literal
 * markers on malformed nesting and could not express bold/italic/links.
 */
import { marked } from 'marked';
import { theme } from './theme.js';
import { StringLru } from './string-lru.js';

/**
 * ONE declarative kind→style table (ZCode's capture→token model,
 * md-structured-inline 02): the renderer contains no per-kind decisions.
 */
export interface InlineStyle {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  color?: string;
  backgroundColor?: string;
  /** Links append the raw target as a muted tail (terminals can't click). */
  hrefTail?: boolean;
}

export const INLINE_STYLE: Record<InlineNode['kind'], InlineStyle> = {
  text: {},
  strong: { bold: true, color: theme.mdStrong },
  em: { italic: true, color: theme.mdEmph },
  del: { strikethrough: true, color: theme.muted },
  codespan: { color: theme.success, backgroundColor: theme.panel },
  link: { underline: true, color: theme.mdLink, hrefTail: true },
  br: {},
};

/** One inline node; `children` recurses for strong/em/del/link labels. */
export interface InlineNode {
  kind: 'text' | 'strong' | 'em' | 'del' | 'codespan' | 'link' | 'br';
  text?: string;
  href?: string;
  children?: readonly InlineNode[];
}

interface RawInlineToken {
  type: string;
  raw?: string;
  text?: string;
  href?: string;
  tokens?: RawInlineToken[];
}

function convertTokens(tokens: RawInlineToken[]): InlineNode[] {
  const out: InlineNode[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'strong':
      case 'em':
      case 'del':
        out.push({ kind: t.type, children: convertTokens(t.tokens ?? [{ type: 'text', text: t.text ?? '' }]) });
        break;
      case 'link':
        out.push({ kind: 'link', href: t.href ?? '', children: convertTokens(t.tokens ?? [{ type: 'text', text: t.text ?? '' }]) });
        break;
      case 'codespan':
        out.push({ kind: 'codespan', text: t.text ?? '' });
        break;
      case 'br':
        out.push({ kind: 'br' });
        break;
      case 'escape':
        out.push({ kind: 'text', text: t.text ?? '' });
        break;
      case 'text': {
        // Loose text tokens may carry nested inline tokens (marked quirk).
        const nested = t.tokens ?? [];
        if (nested.length > 0) out.push(...convertTokens(nested));
        else out.push({ kind: 'text', text: t.text ?? t.raw ?? '' });
        break;
      }
      default: {
        const literal = t.raw ?? t.text ?? '';
        if (literal !== '') out.push({ kind: 'text', text: literal });
      }
    }
  }
  return out;
}

/**
 * Parse one inline span into a node tree. Never throws: any lexer failure
 * (e.g. a half-streamed construct) degrades to a single text node so the
 * transcript keeps rendering.
 *
 * Memoised per source string (md-structured-inline 03): streaming frames
 * re-send every block's text, but only the growing tail block actually
 * changes — stable blocks hit the cache and cost zero lexing. Cached arrays
 * are shared and must be treated as immutable by callers (the renderer only
 * reads).
 */
const INLINE_CACHE_CAP = 400;
/** Total cached source characters; streaming deltas would otherwise retain
 * up to INLINE_CACHE_CAP full copies of long answers. */
const INLINE_CHAR_BUDGET = 256 * 1024;
const inlineCache = new StringLru<readonly InlineNode[]>(INLINE_CACHE_CAP, INLINE_CHAR_BUDGET);
const lexStats = { lexes: 0, hits: 0 };

/** Observability seam for the streaming-cost tests. */
export function inlineLexStats(): { lexes: number; hits: number } {
  return { ...lexStats };
}

export function resetInlineLexStats(): void {
  lexStats.lexes = 0;
  lexStats.hits = 0;
}

export function clearInlineCache(): void {
  inlineCache.clear();
}

export function parseInlineNodes(raw: string): readonly InlineNode[] {
  const hit = inlineCache.get(raw);
  if (hit !== undefined) {
    lexStats.hits += 1;
    return hit;
  }
  const nodes = lexInline(raw);
  inlineCache.set(raw, nodes);
  return nodes;
}

function lexInline(raw: string): readonly InlineNode[] {
  lexStats.lexes += 1;
  if (raw === '') return freezeNodes([{ kind: 'text', text: '' }]);
  try {
    const lexer = new marked.Lexer(marked.defaults);
    const tokens = lexer.inlineTokens(raw) as unknown as RawInlineToken[];
    const nodes = convertTokens(tokens);
    return freezeNodes(nodes.length > 0 ? nodes : [{ kind: 'text', text: raw }]);
  } catch {
    return freezeNodes([{ kind: 'text', text: raw }]);
  }
}

/** Cached trees are shared by reference; freeze so a stray mutation cannot
 * poison every later frame. */
function freezeNodes(nodes: readonly InlineNode[]): readonly InlineNode[] {
  for (const n of nodes) if (n.children !== undefined) freezeNodes(n.children);
  return Object.freeze(nodes);
}

/** Concatenated visible text of a tree (no markers). */
export function flattenInline(nodes: readonly InlineNode[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.kind === 'br') out += '\n';
    else if (n.children !== undefined) out += flattenInline(n.children);
    else out += n.text ?? '';
  }
  return out;
}
