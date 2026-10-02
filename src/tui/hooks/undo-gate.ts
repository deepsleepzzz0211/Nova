import { useCallback, useState } from 'react';

/**
 * Two-way /undo gate (context-economics ticket 03), sibling of the approval
 * gate in ./permission-gate: turns the dialog into a promise the command
 * handler can await. Owned by App.tsx so useAgent stays wiring-only.
 */

/** The /undo answer: revert code+conversation, conversation only, or abort. */
export type UndoChoice = 'files' | 'chat' | 'cancel';

/** Pending /undo question shown by UndoChoiceDialog. */
export interface PendingUndoChoice {
  files: string[];
  resolve: (choice: UndoChoice) => void;
}

export interface UndoGate {
  pending: PendingUndoChoice | null;
  /** Called by the /undo command; resolves when the dialog settles. */
  requestChoice: (files: string[]) => Promise<UndoChoice>;
  /** Settle the current question (dialog / unmount cleanup). */
  settle: (choice: UndoChoice) => void;
}

export function useUndoGate(): UndoGate {
  const [pending, setPending] = useState<PendingUndoChoice | null>(null);
  const requestChoice = useCallback(
    (files: string[]) =>
      new Promise<UndoChoice>((resolve) => {
        setPending({ files, resolve });
      }),
    [],
  );
  const settle = useCallback((choice: UndoChoice) => {
    setPending((current) => {
      current?.resolve(choice);
      return null;
    });
  }, []);
  return { pending, requestChoice, settle };
}
