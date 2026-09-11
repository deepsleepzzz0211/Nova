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
import {
  detectCompletion,
  completeCommands,
  fuzzyMatchFiles,
  buildFileIndex,
  type CompletionContext,
} from './completions.js';

/** An active completion popup: context + filtered items + selected index. */
interface ActiveCompletion {
  ctx: CompletionContext;
  items: Array<{ label: string; insert: string }>;
  index: number;
}

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
  onExit,
  fileIndexRoot,
}: InputBarProps): React.ReactElement {
  const [editor, setEditor] = useState<EditorState>(createEditorState);
  // Mirror of the editor state, updated synchronously by `update`. Handlers
  // must read `editorRef.current`, never the render closure's `editor`:
  // key events can arrive in one synchronous burst before React re-renders,
  // making the closure stale (e.g. type then Ctrl+C in the same tick).
  const editorRef = useRef<EditorState>(editor);
  // Active completion (slash command / @ file), or null when closed.
  // completionRef mirrors the state synchronously: key events burst before
  // React re-renders, so handlers must not read the stale closure.
  const completionRef = useRef<ActiveCompletion | null>(null);
  const setC = (fn: (c: ActiveCompletion | null) => ActiveCompletion | null): void => {
    const next = fn(completionRef.current);
    completionRef.current = next;
    setCompletion(next);
  };
  const [completion, setCompletion] = useState<ActiveCompletion | null>(null);
  // Lazy @ file index (walked once per process).
  const fileIndexRef = useRef<string[] | null | 'loading'>(null);

  const refreshCompletion = (): void => {
    const ctx = detectCompletion(editorRef.current.text, editorRef.current.cursor);
    if (ctx === null) {
      setC(() => null);
      return;
    }
    if (ctx.kind === 'slash') {
      const matches = completeCommands(ctx.query);
      setC(() => ({
        ctx,
        items: matches.map((m) => ({ label: `/${m.name} — ${m.description}`, insert: `/${m.name} ` })),
        index: 0,
      }));
      return;
    }
    // @ file: ensure the index is loaded, then fuzzy-match.
    if (fileIndexRef.current === null) {
      fileIndexRef.current = 'loading';
      void buildFileIndex(fileIndexRoot ?? process.cwd()).then((files) => {
        fileIndexRef.current = files;
        // Recompute now that the index arrived.
        refreshCompletion();
      });
      return;
    }
    if (fileIndexRef.current === 'loading') return; // index still walking
    const matches = fuzzyMatchFiles(fileIndexRef.current, ctx.query);
    setC(() => ({
      ctx,
      items: matches.map((f) => ({ label: f, insert: f })),
      index: 0,
    }));
  };

  const acceptCompletion = (item: { insert: string }): void => {
    const c = completionRef.current;
    if (c === null) return;
    update((e) => replaceToken(e, c.ctx.tokenStart, e.cursor, item.insert));
    setC(() => null);
  };
  const update = (fn: (e: EditorState) => EditorState): void => {
    const next = fn(editorRef.current);
    editorRef.current = next;
    setEditor(next);
  };

  useInput((inputChar, key) => {
    if (key.escape && completionRef.current !== null) {
      // Close the popup first; interrupt only when no popup is open.
      setC(() => null);
      return;
    }
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
      } else if (completionRef.current !== null && !key.ctrl) {
        const c = completionRef.current;
        acceptCompletion(c.items[c.index]);
      } else if (!isStreaming) {
        const r = submit(editorRef.current);
        update(() => r.state);
        if (r.submitted !== null) onSubmit(r.submitted);
      }
      return;
    }

    if (key.upArrow) {
      if (completionRef.current !== null) {
        setC((c) => (c === null ? c : { ...c, index: Math.max(0, c.index - 1) }));
        return;
      }
      update((e) => (cursorLine(e) === 0 ? historyPrev(e) : moveUp(e)));
      return;
    }
    if (key.downArrow) {
      if (completionRef.current !== null) {
        setC((c) =>
          c === null ? c : { ...c, index: Math.min(c.items.length - 1, c.index + 1) },
        );
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
      const c = completionRef.current;
      if (c !== null) {
        acceptCompletion(c.items[c.index]);
      }
      return;
    }
    if (key.escape && completionRef.current !== null) {
      setC(() => null);
      return;
    }

    // Ctrl/meta combos not handled above are ignored (escape sequences).
    if (key.ctrl || key.meta) return;

    if (inputChar) {
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
      onSelect={(i) => setCompletion((c) => (c === null ? c : { ...c, index: i }))}
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
  completion: ActiveCompletion | null;
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
        <Text color="gray" dimColor>
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
      {completion !== null && (
        <Box flexDirection="column" marginTop={0}>
          {completion.items.map((item, i) => (
            <Box key={item.label} paddingLeft={1}>
              <Text inverse={i === completion.index} color={i === completion.index ? 'cyan' : 'gray'}>
                {item.label}
              </Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
