import { parseBlocksWithRaw, type MdBlock } from './markdown.js';
import { clearHighlightCache } from './markdown.js';

/**
 * Streaming render caches (md-structured-inline 03): transcript frames
 * arrive as append-only growth, so parsing must cost O(delta).
 *
 * Two layers:
 *  - exact-text LRU over whole documents (unchanged messages replay free);
 *  - prefix reuse: when the new text merely APPENDS to a previous parse
 *    whose blocks were all closed (ends on a blank line), the cached block
 *    list is kept and only the tail is lexed.
 */

const CACHE_CAP = 200;
/** Total cached source characters; streaming deltas would otherwise retain
 * up to CACHE_CAP full message copies. */
const CACHE_CHAR_BUDGET = 512 * 1024;

interface LastParse {
  text: string;
  blocks: MdBlock[];
  /** Sum of consumed token raws; the rest is trailing whitespace. */
  rawLen: number;
  /** All blocks are final: the source ended on a blank line. */
  closed: boolean;
}

const blockCache = new Map<string, MdBlock[]>();
let cachedChars = 0;
let lastParse: LastParse | null = null;
const lexStats = { full: 0, prefix: 0 };

/** Observability seam for the streaming-cost tests. */
export function blockLexStats(): { full: number; prefix: number } {
  return { ...lexStats };
}

export function resetBlockLexStats(): void {
  lexStats.full = 0;
  lexStats.prefix = 0;
}

export function clearBlockCache(): void {
  blockCache.clear();
  cachedChars = 0;
  lastParse = null;
  clearHighlightCache();
}

function remember(text: string, blocks: MdBlock[], rawLen: number, closed: boolean): void {
  lastParse = { text, blocks, rawLen, closed };
  blockCache.set(text, blocks);
  cachedChars += text.length;
  while (blockCache.size > CACHE_CAP || (cachedChars > CACHE_CHAR_BUDGET && blockCache.size > 1)) {
    const oldest = blockCache.keys().next().value;
    if (oldest === undefined) break;
    blockCache.delete(oldest);
    cachedChars -= oldest.length;
  }
}

/** Cached parse: identical text returns the identical array (memoised). */
export function getCachedBlocks(text: string): MdBlock[] {
  const hit = blockCache.get(text);
  if (hit !== undefined) {
    blockCache.delete(text);
    blockCache.set(text, hit);
    return hit;
  }

  const prev = lastParse;
  if (prev !== null && prev.closed && text.startsWith(prev.text)) {
    const tail = text.slice(prev.rawLen);
    const tailParse = parseBlocksWithRaw(tail);
    const blocks = [...prev.blocks, ...tailParse.blocks];
    lexStats.prefix += 1;
    remember(text, blocks, prev.rawLen + tailParse.rawLen, text.endsWith('\n\n'));
    return blocks;
  }

  const parsed = parseBlocksWithRaw(text);
  lexStats.full += 1;
  remember(text, parsed.blocks, parsed.rawLen, text.endsWith('\n\n'));
  return parsed.blocks;
}
