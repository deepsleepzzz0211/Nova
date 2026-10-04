/**
 * arch2 ticket C: the one owner of "render an unknown thrown value as a
 * message". This exact expression had 22 copies across src/ before it.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
