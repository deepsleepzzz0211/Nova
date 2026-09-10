/**
 * Pure multi-line editor state for the InputBar (tui-refactor ticket 02).
 * No Ink/React dependencies — fully unit-testable. The component layer
 * maps key events to these operations and renders the state.
 *
 * Text is a single string (may contain '\n'); the cursor is an index into
 * it. History holds submitted inputs; while browsing, the in-progress
 * draft is saved and restored.
 */
export interface EditorState {
  /** Editor content, may contain newlines. */
  text: string;
  /** Cursor position as an index into `text`. */
  cursor: number;
  /** Submitted inputs, oldest first. */
  history: string[];
  /** Current history browse position; -1 = not browsing. */
  historyIndex: number;
  /** Saved in-progress input while browsing history. */
  draft: string;
  /** Sticky target column for vertical movement; null = derive from cursor. */
  targetCol: number | null;
}

/** Test helper: jump the cursor to an absolute index. */
export function seek(s: EditorState, index: number): EditorState {
  return { ...s, cursor: Math.max(0, Math.min(index, s.text.length)), targetCol: null };
}

export function createEditorState(): EditorState {
  return { text: '', cursor: 0, history: [], historyIndex: -1, draft: '', targetCol: null };
}

/** Line boundaries: indexes of line starts; helper accessors. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineRangeAt(text: string, index: number): { start: number; end: number } {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  const nl = text.indexOf('\n', index);
  const end = nl === -1 ? text.length : nl;
  return { start, end };
}

/** 0-based line the cursor is on. */
export function cursorLine(s: EditorState): number {
  let line = 0;
  for (let i = 0; i < s.cursor; i++) {
    if (s.text[i] === '\n') line++;
  }
  return line;
}

/** 0-based column of the cursor within its line. */
export function cursorColumn(s: EditorState): number {
  return s.cursor - lineRangeAt(s.text, s.cursor).start;
}

export function insertText(s: EditorState, content: string): EditorState {
  // Strip control characters from pasted/typed content (except \n).
  const clean = content.replace(/[^\S\n]\x08/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  const text = s.text.slice(0, s.cursor) + clean + s.text.slice(s.cursor);
  return { ...s, text, cursor: s.cursor + clean.length, targetCol: null, historyIndex: -1 };
}

export function newline(s: EditorState): EditorState {
  return insertText(s, '\n');
}

export function backspace(s: EditorState): EditorState {
  if (s.cursor === 0) return s;
  const text = s.text.slice(0, s.cursor - 1) + s.text.slice(s.cursor);
  return { ...s, text, cursor: s.cursor - 1, targetCol: null, historyIndex: -1 };
}

export function deleteForward(s: EditorState): EditorState {
  if (s.cursor >= s.text.length) return s;
  const text = s.text.slice(0, s.cursor) + s.text.slice(s.cursor + 1);
  return { ...s, text, targetCol: null, historyIndex: -1 };
}

export function moveLeft(s: EditorState): EditorState {
  if (s.cursor === 0) return s;
  return { ...s, cursor: s.cursor - 1, targetCol: null };
}

export function moveRight(s: EditorState): EditorState {
  if (s.cursor >= s.text.length) return s;
  return { ...s, cursor: s.cursor + 1, targetCol: null };
}

export function moveUp(s: EditorState): EditorState {
  const { start } = lineRangeAt(s.text, s.cursor);
  if (start === 0) return s; // first line
  const col = s.targetCol ?? cursorColumn(s);
  const prevEnd = start - 1; // index of the '\n'
  const prevStart = s.text.lastIndexOf('\n', prevEnd - 1) + 1;
  const prevLen = prevEnd - prevStart;
  const cursor = prevStart + Math.min(col, prevLen);
  return { ...s, cursor, targetCol: col };
}

export function moveDown(s: EditorState): EditorState {
  const { end } = lineRangeAt(s.text, s.cursor);
  if (end >= s.text.length) return s; // last line
  const col = s.targetCol ?? cursorColumn(s);
  const nextStart = end + 1;
  const nextNl = s.text.indexOf('\n', nextStart);
  const nextLen = (nextNl === -1 ? s.text.length : nextNl) - nextStart;
  const cursor = nextStart + Math.min(col, nextLen);
  return { ...s, cursor, targetCol: col };
}

export function deleteWordBack(s: EditorState): EditorState {
  const { start } = lineRangeAt(s.text, s.cursor);
  let i = s.cursor;
  // Skip whitespace back, then the word.
  while (i > start && /\s/.test(s.text[i - 1])) i--;
  while (i > start && !/\s/.test(s.text[i - 1])) i--;
  const text = s.text.slice(0, i) + s.text.slice(s.cursor);
  return { ...s, text, cursor: i, targetCol: null, historyIndex: -1 };
}

export function deleteToLineStart(s: EditorState): EditorState {
  const { start } = lineRangeAt(s.text, s.cursor);
  const text = s.text.slice(0, start) + s.text.slice(s.cursor);
  return { ...s, cursor: start, text, targetCol: null, historyIndex: -1 };
}

export function deleteToLineEnd(s: EditorState): EditorState {
  const { end } = lineRangeAt(s.text, s.cursor);
  const text = s.text.slice(0, s.cursor) + s.text.slice(end);
  return { ...s, text, targetCol: null, historyIndex: -1 };
}

export function historyPrev(s: EditorState): EditorState {
  if (s.history.length === 0) return s;
  // Entering browse mode: save the draft.
  const draft = s.historyIndex === -1 ? s.text : s.draft;
  const index = s.historyIndex === -1 ? s.history.length - 1 : Math.max(0, s.historyIndex - 1);
  return { ...s, text: s.history[index], cursor: s.history[index].length, historyIndex: index, draft, targetCol: null };
}

export function historyNext(s: EditorState): EditorState {
  if (s.historyIndex === -1) return s;
  if (s.historyIndex >= s.history.length - 1) {
    // Leave browse mode: restore the draft.
    return { ...s, text: s.draft, cursor: s.draft.length, historyIndex: -1, draft: '', targetCol: null };
  }
  const index = s.historyIndex + 1;
  return { ...s, text: s.history[index], cursor: s.history[index].length, historyIndex: index, targetCol: null };
}

export interface SubmitResult {
  /** New editor state (cleared, history updated) when submitted. */
  state: EditorState;
  /** The submitted text, or null if the input was empty/whitespace-only. */
  submitted: string | null;
}

/** Submit: trim-checked, pushes to history, clears the editor. */
export function submit(s: EditorState): SubmitResult {
  const trimmed = s.text.trim();
  if (!trimmed) return { state: s, submitted: null };
  return {
    state: { ...s, text: '', cursor: 0, history: [...s.history, s.text], historyIndex: -1, draft: '', targetCol: null },
    submitted: s.text,
  };
}

/** Clear the editor content (Ctrl+C), keeping history. */
export function clearEditor(s: EditorState): EditorState {
  return { ...s, text: '', cursor: 0, historyIndex: -1, draft: '', targetCol: null };
}
