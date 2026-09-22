/**
 * Inline markdown handling for the terminal renderer.
 *
 * Two generations live here side by side during the migration:
 *  - inlineText/inlineParts: the legacy regex stripper (md-structured-inline
 *    02 removes it from the render path);
 *  - parseInlineNodes: a CommonMark inline TREE via marked's inline lexer
 *    (md-structured-inline 01, ZCode-style). The renderer walks this tree and
 *    never echoes markup characters, so malformed nesting cannot leak
 *    literal `**` / `` ` `` the way the regex path did.
 */
import { marked } from 'marked';
import { theme } from './theme.js';

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
  children?: InlineNode[];
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
 */
export function parseInlineNodes(raw: string): InlineNode[] {
  if (raw === '') return [{ kind: 'text', text: '' }];
  try {
    const lexer = new marked.Lexer(marked.defaults);
    const tokens = lexer.inlineTokens(raw) as unknown as RawInlineToken[];
    const nodes = convertTokens(tokens);
    return nodes.length > 0 ? nodes : [{ kind: 'text', text: raw }];
  } catch {
    return [{ kind: 'text', text: raw }];
  }
}

/** Concatenated visible text of a tree (no markers). */
export function flattenInline(nodes: InlineNode[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.kind === 'br') out += '\n';
    else if (n.children !== undefined) out += flattenInline(n.children);
    else out += n.text ?? '';
  }
  return out;
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

/** One inline segment: plain text or a code span (tui-redesign 07). */
export interface InlinePart {
  text: string;
  code: boolean;
}

/**
 * Split inline text into plain/code parts. Code spans keep their text and
 * get styled by the renderer (green on panel); every other marker keeps
 * being stripped exactly like inlineText does.
 */
export function inlineParts(raw: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const re = /`([^`]*)`/g;
  let last = 0;
  let pending = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    pending += raw.slice(last, m.index);
    const stripped = inlineText(pending);
    if (stripped !== '') parts.push({ text: stripped, code: false });
    parts.push({ text: m[1], code: true });
    pending = '';
    last = m.index + m[0].length;
  }
  const tail = inlineText(pending + raw.slice(last));
  if (tail !== '' || parts.length === 0) parts.push({ text: tail, code: false });
  return parts;
}
