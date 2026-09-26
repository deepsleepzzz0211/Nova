import type { Dispatch, SetStateAction } from 'react';
import type { ToolCall } from '../../llm/types.js';
import type { ToolDisplay } from '../../tools/types.js';
import { SessionAlwaysRules, dangerReason, type PermissionDecision } from '../permission-display.js';
import { parseToolArgs, toolVerb } from '../tool-summary.js';
import { modeGate, toolClassOf, type ApprovalModeId } from '../approval-mode.js';
import type { DisplayMessage, DisplayToolCall } from '../display-types.js';

/**
 * The approval pipeline behind AgentLoop.onPermissionRequest (p1-p2 11,
 * split out of useAgent): display-kind danger probe, Shift+Tab mode gate,
 * session-scoped always-allow rules, and the interactive dialog handoff.
 * useAgent supplies the setters; all UI state stays where it was created.
 */

/** Pending permission request awaiting user decision. */
export interface PendingPermission {
  call: ToolCall;
  resolve: (decision: PermissionDecision) => void;
}

export interface PermissionGateDeps {
  setMessages: Dispatch<SetStateAction<DisplayMessage[]>>;
  setPendingPermission: (request: PendingPermission | null) => void;
  setToolCallStatus: (callId: string, status: DisplayToolCall['status']) => void;
  approvalModeRef: { current: ApprovalModeId };
  kindOf: (name: string) => ToolDisplay | undefined;
}

export function createPermissionGate(deps: PermissionGateDeps): (call: ToolCall) => Promise<boolean> {
  const { setMessages, setPendingPermission, setToolCallStatus, approvalModeRef, kindOf } = deps;

  // Session-scoped always-allow rules (ticket 04): matching calls are
  // allowed without a dialog.
  const alwaysRules = new SessionAlwaysRules();

  return (call: ToolCall): Promise<boolean> => {
    // Ticket 05: show the awaiting-permission state on the tool block.
    setToolCallStatus(call.id, 'pending');
    const args = parseToolArgs(call.function.arguments);
    const dangerous = dangerReason(call.function.name, args, kindOf) !== null;
    // Shift+Tab approval modes (tui-redesign 10): acceptEdits lets plain
    // file edits through, plan denies every writing tool. Dangerous calls
    // always reach a human either way.
    const gate = modeGate(approvalModeRef.current, toolClassOf(kindOf(call.function.name)), dangerous);
    if (gate === 'allow') {
      setToolCallStatus(call.id, 'running');
      return Promise.resolve(true);
    }
    if (gate === 'deny') {
      setToolCallStatus(call.id, 'running');
      setMessages((prev) => [
        ...prev,
        {
          role: 'system' as const,
          content: `[plan mode] ${toolVerb(call.function.name)} blocked — shift+tab switches approval modes`,
        },
      ]);
      return Promise.resolve(false);
    }
    // Dangerous calls are never session-whitelisted: always-rules must
    // not short-circuit the dialog for them (review finding).
    if (!dangerous && alwaysRules.matches(call.function.name, args, kindOf)) {
      setToolCallStatus(call.id, 'running');
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      // One-shot: the promise ignores a second settle, but the wrapper's
      // side effects must not replay either — settleDanglingPermission and
      // the unmount path call resolve() again on an already-answered
      // request, which used to flip the finished tool row back to running
      // and re-baseline its start time (approval-flow 01).
      let settled = false;
      setPendingPermission({
        call,
        resolve: (decision: PermissionDecision) => {
          if (settled) return;
          settled = true;
          if (decision === 'always' && !dangerous) {
            alwaysRules.add(call.function.name, args, kindOf);
          }
          setToolCallStatus(call.id, 'running');
          setPendingPermission(null);
          resolve(decision !== 'deny');
        },
      });
    });
  };
}
