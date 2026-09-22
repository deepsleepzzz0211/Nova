import { parseBlocksWithRaw, type MdBlock } from './markdown.js';
import { clearHighlightCache } from './markdown.js';
import { StringLru } from './string-lru.js';

/**
 * Streaming render caches (md-structured-inline 03): transcript frames
 * arrive as append-only growth, so parsing must cost O(delta).
 *
 * Two layers:
 *  - exact-text LRU over whole documents (unchanged messages replay free);
 *  - prefix reuse: when the new text merely APPENDS to a previous parse
 *    whose last block is provably final, the cached block list is kept and
 *    only the tail is lexed.
 *
 * Closure is deliberately conservative: the previous text must end on a
 * blank line, every character must have been consumed by tokens (no stray
 * trailing state), and the last block must be a type that later content
 * cannot absorb — lists and blockquotes swallow following items/lines into
 * the SAME block, so a cached list/quote tail disables the fast path
 * (review finding: prefix reuse must never change the parse result).
 */

const CACHE_CAP = 200;
/** Total cached source characters; streaming deltas would otherwise retain
 * up to CACHE_CAP full message copies. */
const CACHE_CHAR_BUDGET = 512 * 1024;

interface LastParse {
  text: string;
  blocks: MdBlock[];
  /** Sum of consumed token raws; equals text.length when nothing dangles. */
  rawLen: number;
}

const blockCache = new StringLru<MdBlock[]>(CACHE_CAP, CACHE_CHAR_BUDGET);
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
  lastParse = null;
  clearHighlightCache();
}

/** marked normalizes CRLF/CR internally; cache offsets must speak the same
 * single newline language (review finding: rawLen is a normalized offset). */
function normalize(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
}

/** Can later appended text change how `blocks` ends? */
function reusableTail(blocks: MdBlock[]): boolean {
  const last = blocks[blocks.length - 1];
  return last !== undefined && last.kind !== 'list' && last.kind !== 'quote';
}

function closedEnough(text: string, rawLen: number, blocks: MdBlock[]): boolean {
  return text.endsWith('\n\n') && rawLen === text.length && reusableTail(blocks);
}

/** Cached parse: identical text returns the identical array (memoised). */
export function getCachedBlocks(input: string): MdBlock[] {
  const text = normalize(input);
  const hit = blockCache.get(text);
  if (hit !== undefined) return hit;

  const prev = lastParse;
  if (
    prev !== null &&
    prev.rawLen === prev.text.length &&
    closedEnough(prev.text, prev.rawLen, prev.blocks) &&
    text.startsWith(prev.text)
  ) {
    const tail = text.slice(prev.rawLen);
    const tailParse = parseBlocksWithRaw(tail);
    const blocks = [...prev.blocks, ...tailParse.blocks];
    lexStats.prefix += 1;
    lastParse = { text, blocks, rawLen: prev.rawLen + tailParse.rawLen };
    blockCache.set(text, blocks);
    return blocks;
  }

  const parsed = parseBlocksWithRaw(text);
  lexStats.full += 1;
  lastParse = { text, blocks: parsed.blocks, rawLen: parsed.rawLen };
  blockCache.set(text, parsed.blocks);
  return parsed.blocks;
}
