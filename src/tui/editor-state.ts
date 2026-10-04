/**
 * Multi-line editor state for the InputBar (tui-refactor ticket 02; arch2
 * ticket B3 deepening). No Ink/React dependencies — fully unit-testable.
 *
 * The INTERFACE is one reducer: `applyAction(state, EditorAction)` plus the
 * read-only views the renderer needs. The ~17 editing operations (insert,
 * backspace, arrow/history moves, paste fold, token replace, ...) are the
 * IMPLEMENTATION behind that seam — previously each was exported and InputBar
 * hand-wired ~18 of them to key events and had to know the browse-mode /
 * targetCol invariants; now it dispatches plain data and owns only the ink key
 * decoding, while those invariants live in exactly one place (afterEdit + the
 * reducer). Text is a single string (may contain '\n'); cursor is an index;
 * history holds submitted inputs and the draft is saved/restored while
 * browsing.
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
  /** Bodies of folded large pastes, referenced by 1-based index in placeholders. */
  pastes: string[];
}

/** Common post-edit invariant: reset sticky column and browse mode. */
function afterEdit(s: EditorState, text: string, cursor: number): EditorState {
  return { ...s, text, cursor, targetCol: null, historyIndex: -1 };
}

export function createEditorState(): EditorState {
  return { text: '', cursor: 0, history: [], historyIndex: -1, draft: '', targetCol: null, pastes: [] };
}

/** Paste fold threshold: bodies above this line count become placeholders. */
const PASTE_FOLD_LINES = 10;

/**
 * Insert pasted content. Multi-line bodies beyond the threshold are stored
 * in `pastes` and replaced by a compact `[paste #k +N lines]` placeholder;
 * submit() expands placeholders back to the original body.
 */
function insertPaste(s: EditorState, content: string): EditorState {
  const lineCount = content.split('\n').length;
  if (lineCount <= PASTE_FOLD_LINES) return insertText(s, content);
  const index = s.pastes.length + 1;
  const placeholder = `[paste #${index} +${lineCount} lines]`;
  const next = insertText(s, placeholder);
  return { ...next, pastes: [...s.pastes, content] };
}

/** Expand all paste placeholders in `text` using the stored bodies.
 * Accepted risk: a user-typed literal matching the placeholder pattern with
 * a valid index would also be expanded. The pattern is rare in prose and
 * the rewrite only affects the user's own submitted text.
 */
function expandPastes(text: string, pastes: string[]): string {
  return text.replace(/\[paste #(\d+) \+\d+ lines\]/g, (match, index) => {
    const body = pastes[Number(index) - 1];
    return body === undefined ? match : body;
  });
}

/** Replace a token range with new content (used by completion acceptance). */
function replaceToken(s: EditorState, start: number, end: number, content: string): EditorState {
  const clampedStart = Math.max(0, Math.min(start, s.text.length));
  const clampedEnd = Math.max(clampedStart, Math.min(end, s.text.length));
  return afterEdit(
    s,
    s.text.slice(0, clampedStart) + content + s.text.slice(clampedEnd),
    clampedStart + content.length,
  );
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

function insertText(s: EditorState, content: string): EditorState {
  // Strip control characters from pasted/typed content (except \n).
  const clean = content.replace(/[^\S\n]\x08/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  const text = s.text.slice(0, s.cursor) + clean + s.text.slice(s.cursor);
  return { ...s, text, cursor: s.cursor + clean.length, targetCol: null, historyIndex: -1 };
}

function newline(s: EditorState): EditorState {
  return insertText(s, '\n');
}

function backspace(s: EditorState): EditorState {
  if (s.cursor === 0) return s;
  return afterEdit(s, s.text.slice(0, s.cursor - 1) + s.text.slice(s.cursor), s.cursor - 1);
}

function deleteForward(s: EditorState): EditorState {
  if (s.cursor >= s.text.length) return s;
  return afterEdit(s, s.text.slice(0, s.cursor) + s.text.slice(s.cursor + 1), s.cursor);
}

function moveLeft(s: EditorState): EditorState {
  if (s.cursor === 0) return s;
  return { ...s, cursor: s.cursor - 1, targetCol: null };
}

function moveRight(s: EditorState): EditorState {
  if (s.cursor >= s.text.length) return s;
  return { ...s, cursor: s.cursor + 1, targetCol: null };
}

function moveUp(s: EditorState): EditorState {
  const { start } = lineRangeAt(s.text, s.cursor);
  if (start === 0) return s; // first line
  const col = s.targetCol ?? cursorColumn(s);
  const prevEnd = start - 1; // index of the '\n'
  const prevStart = s.text.lastIndexOf('\n', prevEnd - 1) + 1;
  const prevLen = prevEnd - prevStart;
  const cursor = prevStart + Math.min(col, prevLen);
  return { ...s, cursor, targetCol: col };
}

function moveDown(s: EditorState): EditorState {
  const { end } = lineRangeAt(s.text, s.cursor);
  if (end >= s.text.length) return s; // last line
  const col = s.targetCol ?? cursorColumn(s);
  const nextStart = end + 1;
  const nextNl = s.text.indexOf('\n', nextStart);
  const nextLen = (nextNl === -1 ? s.text.length : nextNl) - nextStart;
  const cursor = nextStart + Math.min(col, nextLen);
  return { ...s, cursor, targetCol: col };
}

function deleteWordBack(s: EditorState): EditorState {
  const { start } = lineRangeAt(s.text, s.cursor);
  let i = s.cursor;
  // Skip whitespace back, then the word.
  while (i > start && /\s/.test(s.text[i - 1])) i--;
  while (i > start && !/\s/.test(s.text[i - 1])) i--;
  return afterEdit(s, s.text.slice(0, i) + s.text.slice(s.cursor), i);
}

function deleteToLineStart(s: EditorState): EditorState {
  const { start } = lineRangeAt(s.text, s.cursor);
  return afterEdit(s, s.text.slice(0, start) + s.text.slice(s.cursor), start);
}

function deleteToLineEnd(s: EditorState): EditorState {
  const { end } = lineRangeAt(s.text, s.cursor);
  return afterEdit(s, s.text.slice(0, s.cursor) + s.text.slice(end), s.cursor);
}

function historyPrev(s: EditorState): EditorState {
  if (s.history.length === 0) return s;
  // Entering browse mode: save the draft.
  const draft = s.historyIndex === -1 ? s.text : s.draft;
  const index = s.historyIndex === -1 ? s.history.length - 1 : Math.max(0, s.historyIndex - 1);
  return { ...s, text: s.history[index], cursor: s.history[index].length, historyIndex: index, draft, targetCol: null };
}

function historyNext(s: EditorState): EditorState {
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
  const expanded = expandPastes(s.text, s.pastes);
  const trimmed = expanded.trim();
  if (!trimmed) return { state: s, submitted: null };
  return {
    state: {
      ...s,
      text: '',
      cursor: 0,
      history: [...s.history, expanded],
      historyIndex: -1,
      draft: '',
      targetCol: null,
      pastes: [],
    },
    submitted: expanded,
  };
}

/** Clear the editor content (Ctrl+C), keeping history. */
function clearEditor(s: EditorState): EditorState {
  return { ...s, text: '', cursor: 0, historyIndex: -1, draft: '', targetCol: null };
}

/**
 * The editing intent InputBar dispatches (arch2 ticket B3). Plain data, no
 * ink coupling: InputBar decodes the raw key event into one of these and the
 * reducer owns the resulting state transition + every invariant (sticky
 * targetCol, browse-mode reset, paste fold). Adding a new edit = one variant
 * here + one case in applyAction, instead of touching the component's keymap.
 */
export type EditorAction =
  | { kind: 'insert'; text: string }
  | { kind: 'newline' }
  | { kind: 'paste'; content: string }
  | { kind: 'replaceToken'; start: number; end: number; content: string }
  | { kind: 'backspace' }
  | { kind: 'deleteForward' }
  | { kind: 'deleteWordBack' }
  | { kind: 'deleteToLineStart' }
  | { kind: 'deleteToLineEnd' }
  | { kind: 'clear' }
  | { kind: 'left' }
  | { kind: 'right' }
  | { kind: 'up' }
  | { kind: 'down' }
  | { kind: 'historyPrev' }
  | { kind: 'historyNext' };

/** The single editing entry point: state in, state out. Submit is separate
 *  (it returns the submitted text as a side value, see {@link submit}). */
export function applyAction(s: EditorState, action: EditorAction): EditorState {
  switch (action.kind) {
    case 'insert': return insertText(s, action.text);
    case 'newline': return newline(s);
    case 'paste': return insertPaste(s, action.content);
    case 'replaceToken': return replaceToken(s, action.start, action.end, action.content);
    case 'backspace': return backspace(s);
    case 'deleteForward': return deleteForward(s);
    case 'deleteWordBack': return deleteWordBack(s);
    case 'deleteToLineStart': return deleteToLineStart(s);
    case 'deleteToLineEnd': return deleteToLineEnd(s);
    case 'clear': return clearEditor(s);
    case 'left': return moveLeft(s);
    case 'right': return moveRight(s);
    case 'up': return moveUp(s);
    case 'down': return moveDown(s);
    case 'historyPrev': return historyPrev(s);
    case 'historyNext': return historyNext(s);
  }
}
