import { theme } from './theme.js';
import type { ToolDisplay } from '../shared/tool-contracts.js';

/**
 * Approval modes cycled by Shift+Tab (tui-redesign 10, Claude-Code-style):
 * default asks per call, acceptEdits auto-allows non-dangerous file edits,
 * plan denies every writing tool. The gate returns a decision ONLY for the
 * confirmation step — the existing permission pipeline (narrow-approval,
 * always-rules, dangerous highlighting) stays the caller of record.
 */
export type ApprovalModeId = 'default' | 'acceptEdits' | 'plan';

/** Coarse tool class the gate reasons over (from registry display data). */
export type ToolClass = 'read' | 'edit' | 'execute';

const RING: readonly ApprovalModeId[] = ['default', 'acceptEdits', 'plan'];

export function nextApprovalMode(current: ApprovalModeId): ApprovalModeId {
  const idx = RING.indexOf(current);
  return RING[(idx + 1) % RING.length];
}

/** Badge pieces for the bottom status line. */
export function modeBadge(mode: ApprovalModeId): { symbol: string; label: string; color: string } {
  switch (mode) {
    case 'acceptEdits':
      return { symbol: '⚠', label: 'accept edits', color: theme.warning };
    case 'plan':
      return { symbol: '◉', label: 'plan', color: theme.secondary };
    case 'default':
      return { symbol: '⏵', label: 'default', color: theme.muted };
  }
}

/**
 * Gate a confirmation request through the active mode. Dangerous calls are
 * never short-circuited (an accept is still a human decision).
 */
export function modeGate(
  mode: ApprovalModeId,
  toolClass: ToolClass,
  dangerous: boolean,
): 'allow' | 'deny' | 'ask' {
  if (dangerous) return 'ask';
  switch (mode) {
    case 'default':
      return 'ask';
    case 'acceptEdits':
      return toolClass === 'edit' ? 'allow' : 'ask';
    case 'plan':
      return toolClass === 'read' ? 'ask' : 'deny';
  }
}

/** Tool class from registry display metadata: diff tools edit, commands execute. */
export function toolClassOf(display: ToolDisplay | undefined): ToolClass {
  if (display === undefined) return 'read';
  if (display.diff !== undefined) return 'edit';
  if (display.kind === 'command') return 'execute';
  return 'read';
}
