/**
 * Line-level diff view for edit/write tool calls (tui-refactor ticket 06).
 * Derived from the call arguments, so no tool changes are needed: an edit
 * shows the replaced block as removals and the new block as additions, a
 * write shows its content as additions.
 */
export type DiffLineKind = 'add' | 'del' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface DiffView {
  /** One-line header: path plus change counts. */
  header: string;
  lines: DiffLine[];
  added: number;
  removed: number;
}

export type DiffMode = 'edit' | 'write';

function toLines(text: string): string[] {
  // Trailing newline should not produce a phantom empty line.
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed === '' ? [] : trimmed.split('\n');
}

/** Build the diff view for an edit/write call, or null when args are unusable. */
export function buildDiffView(
  args: Record<string, unknown> | null,
  mode: DiffMode,
): DiffView | null {
  if (args === null) return null;
  const filePath = typeof args.path === 'string' ? args.path : '(unknown path)';

  const oldLines = mode === 'edit' ? toLines(typeof args.old_string === 'string' ? args.old_string : '') : [];
  const newText = mode === 'edit'
    ? (typeof args.new_string === 'string' ? args.new_string : '')
    : (typeof args.content === 'string' ? args.content : '');
  // Append shows the appended block as additions, like a write.
  const newLines = toLines(newText);

  if (oldLines.length === 0 && newLines.length === 0) return null;

  const lines: DiffLine[] = [
    ...oldLines.map((text): DiffLine => ({ kind: 'del', text })),
    ...newLines.map((text): DiffLine => ({ kind: 'add', text })),
  ];

  const verb = mode === 'edit' ? 'edit' : args.mode === 'append' ? 'append' : 'write';
  const header = `${verb} ${filePath} (+${newLines.length} -${oldLines.length})`;

  return { header, lines, added: newLines.length, removed: oldLines.length };
}

/** Cap the rendered diff and report how many lines were hidden. */
export function foldDiff(view: DiffView, max = 30): { lines: DiffLine[]; hidden: number } {
  if (view.lines.length <= max) return { lines: view.lines, hidden: 0 };
  return { lines: view.lines.slice(0, max), hidden: view.lines.length - max };
}
