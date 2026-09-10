import React, { useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
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
  type EditorState,
} from './editor-state.js';

/** Props for the InputBar component. */
export interface InputBarProps {
  /** Callback when the user submits input by pressing Enter. */
  onSubmit: (input: string) => void;
  /** Whether the agent is currently streaming a response. */
  isStreaming: boolean;
  /** Called when the user presses Escape while a response is streaming. */
  onInterrupt?: () => void;
  /** Called when the user presses Ctrl+C on an empty editor (app exit). */
  onExit?: () => void;
}

/**
 * Multi-line editor for user messages (pi-style, tui-refactor ticket 02).
 *
 * - Multi-line editing with a fake cursor (Shift+Enter / Ctrl+Enter newline)
 * - Standard editing: arrows, backspace/delete, Ctrl+W word delete,
 *   Ctrl+U line-start clear, Ctrl+K line-end clear
 * - Up/Down recall input history when on the first/last line
 * - Enter submits; Esc interrupts a streaming response
 * - Ctrl+C clears the editor; Ctrl+C on an empty editor exits (pi semantics)
 */
export function InputBar({ onSubmit, isStreaming, onInterrupt, onExit }: InputBarProps): React.ReactElement {
  const [editor, setEditor] = useState<EditorState>(createEditorState);
  // Mirror of the editor state, updated synchronously by `update`. Handlers
  // must read `editorRef.current`, never the render closure's `editor`:
  // key events can arrive in one synchronous burst before React re-renders,
  // making the closure stale (e.g. type then Ctrl+C in the same tick).
  const editorRef = useRef<EditorState>(editor);
  const update = (fn: (e: EditorState) => EditorState): void => {
    const next = fn(editorRef.current);
    editorRef.current = next;
    setEditor(next);
  };

  useInput((inputChar, key) => {
    if (key.escape && isStreaming) {
      onInterrupt?.();
      return;
    }

    if (key.ctrl && inputChar === 'c') {
      // pi semantics: clear the editor first; exit when already empty.
      if (editorRef.current.text) {
        update(clearEditor);
        return;
      }
      onExit?.();
    }

    // Ctrl+W / Ctrl+U / Ctrl+K line editing
    if (key.ctrl && inputChar === 'w') {
      update(deleteWordBack);
      return;
    }
    if (key.ctrl && inputChar === 'u') {
      update(deleteToLineStart);
      return;
    }
    if (key.ctrl && inputChar === 'k') {
      update(deleteToLineEnd);
      return;
    }

    // Enter: newline with Shift/Ctrl (Windows Terminal Ctrl+Enter = LF);
    // plain Enter submits.
    if (key.return || inputChar === '\n') {
      const wantsNewline = key.shift || key.ctrl || inputChar === '\n';
      if (wantsNewline) {
        update(newline);
      } else if (!isStreaming) {
        const r = submit(editorRef.current);
        update(() => r.state);
        if (r.submitted !== null) onSubmit(r.submitted);
      }
      return;
    }

    if (key.upArrow) {
      update((e) => (cursorLine(e) === 0 ? historyPrev(e) : moveUp(e)));
      return;
    }
    if (key.downArrow) {
      update((e) => {
        const lines = e.text.split('\n').length;
        return cursorLine(e) === lines - 1 ? historyNext(e) : moveDown(e);
      });
      return;
    }
    if (key.leftArrow) {
      update(moveLeft);
      return;
    }
    if (key.rightArrow) {
      update(moveRight);
      return;
    }
    if (key.backspace) {
      update(backspace);
      return;
    }
    if (key.delete) {
      update(deleteForward);
      return;
    }
    if (key.tab) {
      // Tab completion arrives in ticket 03; ignore for now.
      return;
    }

    // Ctrl/meta combos not handled above are ignored (escape sequences).
    if (key.ctrl || key.meta) return;

    if (inputChar) {
      update((e) => insertText(e, inputChar));
    }
  });

  return <EditorView editor={editor} isStreaming={isStreaming} />;
}

/** Renders the multi-line editor content with a fake block cursor. */
function EditorView({ editor, isStreaming }: { editor: EditorState; isStreaming: boolean }): React.ReactElement {
  const lines = editor.text.split('\n');
  const cursorRow = cursorLine(editor);
  const cursorCol = cursorColumn(editor);
  const borderColor = isStreaming ? 'gray' : 'cyan';

  return (
    <Box borderStyle="round" borderColor={borderColor} paddingX={1} flexDirection="column">
      {editor.text.length === 0 ? (
        <Text color="gray" dimColor>
          {isStreaming ? '(waiting for response... — type anyway)' : 'Type a message... (Shift+Enter for newline)'}
        </Text>
      ) : (
        lines.map((line, row) => {
          if (row === cursorRow) {
            const at = line[cursorCol] ?? ' ';
            return (
              <Box key={row}>
                <Text color="white">{line.slice(0, cursorCol)}</Text>
                <Text inverse color="white">{at}</Text>
                <Text color="white">{line.slice(cursorCol + 1)}</Text>
              </Box>
            );
          }
          return (
            <Box key={row}>
              <Text color="white">{line}</Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}
