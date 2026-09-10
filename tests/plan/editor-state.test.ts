import { describe, it, expect } from 'vitest';
import type { EditorState } from '../../src/tui/editor-state.js';
import {
  createEditorState,
  insertText,
  newline,
  backspace,
  deleteForward,
  moveLeft,
  moveRight,
  moveUp,
  moveDown,
  deleteWordBack,
  deleteToLineStart,
  deleteToLineEnd,
  historyPrev,
  historyNext,
  submit,
  clearEditor,
  cursorLine,
  cursorColumn,
} from '../../src/tui/editor-state.js';

/** Local test helper: jump the cursor to an absolute index. */
function seek(s: EditorState, index: number): EditorState {
  return { ...s, cursor: Math.max(0, Math.min(index, s.text.length)), targetCol: null };
}

describe('EditorState (tui-refactor 02)', () => {
  it('starts empty with cursor 0', () => {
    const s = createEditorState();
    expect(s.text).toBe('');
    expect(s.cursor).toBe(0);
  });

  describe('insert', () => {
    it('inserts text at cursor', () => {
      let s = createEditorState();
      s = insertText(s, 'hello');
      expect(s.text).toBe('hello');
      expect(s.cursor).toBe(5);
      s = insertText(s, ' world');
      expect(s.text).toBe('hello world');
    });

    it('inserts mid-string', () => {
      let s = insertText(createEditorState(), 'helo');
      s = moveLeft(s);
      s = moveLeft(s);
      s = insertText(s, 'l');
      expect(s.text).toBe('hello');
    });

    it('newline inserts a break and moves the cursor to the next line start', () => {
      let s = insertText(createEditorState(), 'ab');
      s = moveLeft(s);
      s = newline(s);
      expect(s.text).toBe('a\nb');
      expect(cursorLine(s)).toBe(1); // cursor after the break
      expect(cursorColumn(s)).toBe(0);
    });
  });

  describe('movement', () => {
    it('left/right move within and across lines', () => {
      let s = insertText(createEditorState(), 'ab\ncd'); // cursor 5 (line 1 end)
      s = moveLeft(s);
      s = moveLeft(s); // cursor 3 = start of line 2
      expect(cursorLine(s)).toBe(1);
      expect(cursorColumn(s)).toBe(0);
      s = moveLeft(s); // crosses back to end of line 1
      expect(cursorLine(s)).toBe(0);
      expect(cursorColumn(s)).toBe(2);
      s = moveRight(s); // forward across to line 2 start
      expect(cursorLine(s)).toBe(1);
    });

    it('left at start and right at end clamp', () => {
      let s = insertText(createEditorState(), 'ab');
      s = moveLeft(s);
      s = moveLeft(s);
      s = moveLeft(s);
      expect(s.cursor).toBe(0);
      s = moveRight(s);
      s = moveRight(s);
      s = moveRight(s);
      expect(s.cursor).toBe(2);
    });

    it('up/down preserve the target column and clamp at line bounds', () => {
      let s = insertText(createEditorState(), 'ab\nabcdef'); // cursor 9 = line 1 col 6
      s = moveUp(s); // line 0 is shorter: column clamps to 2
      expect(cursorLine(s)).toBe(0);
      expect(cursorColumn(s)).toBe(2);
      s = moveDown(s); // target column 6 preserved, line 1 is long enough
      expect(cursorLine(s)).toBe(1);
      expect(cursorColumn(s)).toBe(6);
    });

    it('up on first line and down on last line are no-ops', () => {
      let s = insertText(createEditorState(), 'ab');
      s = moveUp(s);
      expect(s.cursor).toBe(2);
      s = moveDown(s);
      expect(s.cursor).toBe(2);
    });
  });

  describe('delete', () => {
    it('backspace removes char before cursor and joins lines', () => {
      let s = insertText(createEditorState(), 'ab\ncd'); // cursor 5
      s = moveLeft(s); // cursor 4
      s = moveLeft(s); // cursor 3
      s = backspace(s); // remove '\n' -> 'abcd'
      expect(s.text).toBe('abcd');
      expect(s.cursor).toBe(2);
    });

    it('backspace at start is a no-op', () => {
      let s = insertText(createEditorState(), 'ab');
      s = moveLeft(s);
      s = moveLeft(s);
      s = backspace(s);
      expect(s.text).toBe('ab');
    });

    it('deleteForward removes char at cursor', () => {
      let s = insertText(createEditorState(), 'ab');
      s = moveLeft(s);
      s = moveLeft(s);
      s = deleteForward(s);
      expect(s.text).toBe('b');
      expect(s.cursor).toBe(0);
    });

    it('deleteWordBack removes to the previous word start', () => {
      let s = insertText(createEditorState(), 'hello world');
      s = deleteWordBack(s);
      expect(s.text).toBe('hello ');
      expect(s.cursor).toBe(6);
      s = deleteWordBack(s);
      expect(s.text).toBe('');
    });

    it('deleteToLineStart/End operate within the line', () => {
      let s = insertText(createEditorState(), 'ab\ncdef'); // cursor 7 (line 1 end)
      s = seek(s, 4); // line 1, col 1
      s = deleteToLineStart(s);
      expect(s.text).toBe('ab\ndef');
      expect(cursorColumn(s)).toBe(0);
      s = seek(s, 4); // line 1, col 1 ('d' kept, 'ef' removed)
      s = deleteToLineEnd(s);
      expect(s.text).toBe('ab\nd');
    });
  });

  describe('history', () => {
    it('submit pushes non-empty input and clears editor', () => {
      let s = insertText(createEditorState(), 'first');
      const r = submit(s);
      expect(r.submitted).toBe('first');
      expect(r.state.text).toBe('');
      expect(r.state.history).toEqual(['first']);
      expect(r.state.historyIndex).toBe(-1);
    });

    it('submit of whitespace-only input is rejected', () => {
      const s = insertText(createEditorState(), '   ');
      const r = submit(s);
      expect(r.submitted).toBeNull();
      expect(r.state.history).toEqual([]);
    });

    it('historyPrev recalls past inputs, historyNext returns', () => {
      let s = insertText(createEditorState(), 'one');
      s = submit(s).state;
      s = insertText(s, 'two');
      s = submit(s).state;

      s = historyPrev(s);
      expect(s.text).toBe('two');
      s = historyPrev(s);
      expect(s.text).toBe('one');
      // At oldest; further prev is a no-op
      s = historyPrev(s);
      expect(s.text).toBe('one');

      s = historyNext(s);
      expect(s.text).toBe('two');
      s = historyNext(s);
      // Back to the saved draft (empty)
      expect(s.text).toBe('');
      s = historyNext(s);
      expect(s.text).toBe('');
    });

    it('browsing history with none available is a no-op', () => {
      let s = insertText(createEditorState(), 'draft text');
      s = historyPrev(s); // empty history: recall nothing
      expect(s.text).toBe('draft text');
    });

    it('editing while browsing history exits browse mode', () => {
      let s = insertText(createEditorState(), 'one');
      s = submit(s).state;
      s = insertText(s, 'partial');
      s = historyPrev(s);
      expect(s.text).toBe('one');
      s = insertText(s, 'X');
      expect(s.text).toBe('oneX');
      expect(s.historyIndex).toBe(-1);
    });
  });

  it('clearEditor empties text without touching history', () => {
    let s = insertText(createEditorState(), 'abc');
    s = submit(s).state;
    s = insertText(s, 'draft');
    s = clearEditor(s);
    expect(s.text).toBe('');
    expect(s.history).toEqual(['abc']);
  });
});
