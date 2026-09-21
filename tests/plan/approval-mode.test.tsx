import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import {
  nextApprovalMode,
  modeBadge,
  modeGate,
  type ApprovalModeId,
} from '../../src/tui/approval-mode.js';
import { StatusLine } from '../../src/tui/StatusLine.js';
import { theme } from '../../src/tui/theme.js';

// tui-redesign 10: Shift+Tab cycles default → acceptEdits → plan; the badge
// lives on the bottom status line; the gate plugs into the existing
// permission pipeline without changing its resolve protocol.

describe('mode cycling (tui-redesign 10)', () => {
  it('walks the ring default → acceptEdits → plan → default', () => {
    expect(nextApprovalMode('default')).toBe('acceptEdits');
    expect(nextApprovalMode('acceptEdits')).toBe('plan');
    expect(nextApprovalMode('plan')).toBe('default');
  });

  it('badges carry distinct labels and theme colours', () => {
    const d = modeBadge('default');
    const a = modeBadge('acceptEdits');
    const p = modeBadge('plan');
    expect(d.label).toBe('default');
    expect(a.label).toBe('accept edits');
    expect(a.color).toBe(theme.warning);
    expect(p.label).toBe('plan');
    expect(p.color).toBe(theme.secondary);
    expect(new Set([d.symbol, a.symbol, p.symbol]).size).toBe(3);
  });
});

describe('modeGate (tui-redesign 10)', () => {
  it('default mode asks everywhere the pipeline asks', () => {
    expect(modeGate('default', 'edit', false)).toBe('ask');
    expect(modeGate('default', 'execute', false)).toBe('ask');
    expect(modeGate('default', 'read', false)).toBe('ask');
  });

  it('acceptEdits auto-allows file edits but never dangerous ones', () => {
    expect(modeGate('acceptEdits', 'edit', false)).toBe('allow');
    expect(modeGate('acceptEdits', 'edit', true)).toBe('ask');
    expect(modeGate('acceptEdits', 'execute', false)).toBe('ask');
    expect(modeGate('acceptEdits', 'read', false)).toBe('ask');
  });

  it('plan denies every writing tool, leaves reads asking', () => {
    expect(modeGate('plan', 'edit', false)).toBe('deny');
    expect(modeGate('plan', 'execute', false)).toBe('deny');
    expect(modeGate('plan', 'read', false)).toBe('ask');
  });
});

describe('status-line mode badge (tui-redesign 10)', () => {
  it('shows the badge in the bottom row', () => {
    const frame = render(<StatusLine working="idle" approvalMode="plan" />).lastFrame() ?? '';
    expect(frame).toContain('plan');
  });

  it('a fresh toast replaces the badge text transiently', () => {
    const frame =
      render(<StatusLine working="idle" approvalMode="acceptEdits" modeToast="⚠ accept edits" />).lastFrame() ?? '';
    expect(frame).toContain('⚠ accept edits');
  });

  it('idle with nothing else still collapses (no badge requested)', () => {
    const frame = render(<StatusLine working="idle" />).lastFrame() ?? '';
    expect(frame.trim()).toBe('');
  });
});

describe('type-safety ring', () => {
  it('nextApprovalMode accepts every id', () => {
    const all: ApprovalModeId[] = ['default', 'acceptEdits', 'plan'];
    for (const m of all) expect(all).toContain(nextApprovalMode(m));
  });
});
