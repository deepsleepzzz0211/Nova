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
  insertPaste,
  replaceToken,
  cursorLine,
  cursorColumn,
  type EditorState,
} from './editor-state.js';
import { buildFileIndex } from './completions.js';
import {
  CompletionController,
  type ActiveCompletion,
  type CompletionItem,
} from './completion-controller.js';
import { theme } from './theme.js';

/** Props for the InputBar component. */
export interface InputBarProps {
  /** Callback when the user submits input by pressing Enter. */
  onSubmit: (input: string) => void;
  /** Whether the agent is currently streaming a response. */
  isStreaming: boolean;
  /** Working indicator state driving the editor border color. */
  workingState?: 'idle' | 'streaming' | 'thinking';
  /** Called when the user presses Escape while a response is streaming. */
  onInterrupt?: () => void;
  /**
   * True while a modal (permission dialog) owns the keyboard. Escape must not
   * interrupt the stream then: the dialog handles Escape as "No" and the
   * interrupt path would otherwise leave the dialog dangling (E2E finding).
   */
  modalOpen?: boolean;
  /** Called when the user presses Ctrl+C on an empty editor (app exit). */
  onExit?: () => void;
  /** Root directory for @ file completions (defaults to cwd; test seam). */
  fileIndexRoot?: string;
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
export function InputBar({
  onSubmit,
  isStreaming,
  workingState,
  onInterrupt,
  modalOpen,
  onExit,
  fileIndexRoot,
}: InputBarProps): React.ReactElement {
  const [editor, setEditor] = useState<EditorState>(createEditorState);
  // Mirror of the editor state, updated synchronously by `update`. Handlers
  // must read `editorRef.current`, never the render closure's `editor`:
  // key events can arrive in one synchronous burst before React re-renders,
  // making the closure stale (e.g. type then Ctrl+C in the same tick).
  const editorRef = useRef<EditorState>(editor);
  // Completion popup state machine lives in its own module (ticket 17); this
  // component only renders its state and routes keys to it.
  const [completion, setCompletion] = useState<ActiveCompletion | undefined>(undefined);
  const completionRef = useRef<CompletionController | null>(null);
  if (completionRef.current === null) {
    completionRef.current = new CompletionController({
      commands: (query) => CompletionController.commandItems(query),
      loadFiles: () => buildFileIndex(fileIndexRoot ?? process.cwd()),
      onChange: (state) => setCompletion(state),
    });
  }
  const completionController = completionRef.current;

  const refreshCompletion = (): void => {
    completionController.refresh(editorRef.current.text, editorRef.current.cursor);
  };

  /** Accept the highlighted item into the editor (token replacement). */
  const acceptCompletion = (): void => {
    const accepted = completionController.accept();
    if (accepted === null) return;
    update((e) => replaceToken(e, accepted.tokenStart, accepted.end, accepted.insert));
    completionController.close();
  };

  const update = (fn: (e: EditorState) => EditorState): void => {
    const next = fn(editorRef.current);
    editorRef.current = next;
    setEditor(next);
  };

  useInput((inputChar, key) => {
    if (key.escape && completionController.current !== undefined) {
      // Close the popup first; interrupt only when no popup is open.
      completionController.close();
      return;
    }
    if (key.escape && isStreaming && modalOpen !== true) {
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
      return;
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
      } else if (completionController.wouldChangeText(editorRef.current.text)) {
        // Enter accepts a completion only when it actually completes
        // something; typing an exact command name ("/model") must submit
        // (E2E finding: Enter used to be swallowed by the popup).
        acceptCompletion();
      } else if (!isStreaming) {
        const r = submit(editorRef.current);
        update(() => r.state);
        if (r.submitted !== null) onSubmit(r.submitted);
      }
      return;
    }

    if (key.upArrow) {
      if (completion !== undefined) {
        completionController.move(-1);
        return;
      }
      update((e) => (cursorLine(e) === 0 ? historyPrev(e) : moveUp(e)));
      return;
    }
    if (key.downArrow) {
      if (completion !== undefined) {
        completionController.move(1);
        return;
      }
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
      if (completionController.current !== undefined) acceptCompletion();
      return;
    }

    // Ctrl/meta combos not handled above are ignored (escape sequences).
    if (key.ctrl || key.meta) return;

    if (inputChar) {
      // A chunk that ENDS with CR is text plus Enter delivered in one piece
      // (fast typing, coalescing terminals, automation tools): insert the
      // text, then submit. Without this the trailing Enter is swallowed and
      // the prompt never leaves the editor (E2E finding).
      if (inputChar.length > 1 && inputChar.endsWith('\r') && !isStreaming) {
        const body = inputChar.slice(0, -1);
        if (body !== '') update((e) => insertText(e, body));
        const r = submit(editorRef.current);
        update(() => r.state);
        if (r.submitted !== null) onSubmit(r.submitted);
        completionController.close();
        return;
      }
      // Multi-char events with newlines are terminal pastes: route through
      // insertPaste (folds large bodies into placeholders). Single-char
      // events are normal typing.
      if (inputChar.length > 1 && inputChar.includes('\n')) {
        update((e) => insertPaste(e, inputChar));
      } else {
        update((e) => insertText(e, inputChar));
      }
      refreshCompletion();
    }
  });

  return (
    <EditorView
      editor={editor}
      workingState={workingState ?? (isStreaming ? 'streaming' : 'idle')}
      completion={completion}
      onSelect={(i) => completionController.select(i)}
    />
  );
}

/** Renders the multi-line editor content with a fake block cursor + completion list. */
function EditorView({
  editor,
  workingState,
  completion,
  onSelect,
}: {
  editor: EditorState;
  workingState: 'idle' | 'streaming' | 'thinking';
  completion: ActiveCompletion | undefined;
  onSelect: (index: number) => void;
}): React.ReactElement {
  const lines = editor.text.split('\n');
  const cursorRow = cursorLine(editor);
  const cursorCol = cursorColumn(editor);
  // Working indicator: the editor border doubles as the activity light
  // (tui-refactor ticket 09, pi-style).
  const borderColor =
    workingState === 'thinking' ? 'magenta' : workingState === 'streaming' ? 'yellow' : 'cyan';

  return (
    <Box borderStyle="round" borderColor={borderColor} paddingX={1} flexDirection="column">
      {editor.text.length === 0 ? (
        <Text color={theme.muted} dimColor>
          {workingState !== 'idle'
            ? '(working… — you can still type)'
            : 'Type a message... (Shift+Enter for newline)'}
        </Text>
      ) : (
        lines.map((line, row) => {
          if (row === cursorRow) {
            const at = line[cursorCol] ?? ' ';
            return (
              <Box key={row}>
                <Text color={theme.assistantMessage}>{line.slice(0, cursorCol)}</Text>
                <Text inverse color={theme.assistantMessage}>{at}</Text>
                <Text color={theme.assistantMessage}>{line.slice(cursorCol + 1)}</Text>
              </Box>
            );
          }
          return (
            <Box key={row}>
              <Text color={theme.assistantMessage}>{line}</Text>
            </Box>
          );
        })
      )}
      {completion !== undefined && (
        <Box flexDirection="column" marginTop={0}>
          {completion.items.map((item: CompletionItem, i: number) => (
            <Box key={item.label} paddingLeft={1}>
              <Text inverse={i === completion.index} color={i === completion.index ? theme.primary : theme.muted}>
                {item.label}
              </Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
