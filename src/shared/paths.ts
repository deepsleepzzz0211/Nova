/** Convert Windows separators to forward slashes (the form both our WASM
 *  engine guest and every model-facing path in Nova use). */
export function toSlashes(p: string): string {
  return p.split('\\').join('/');
}
