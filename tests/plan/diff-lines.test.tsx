import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { buildDiffView } from '../../src/tui/diff-view.js';
import { ToolCallView } from '../../src/tui/ToolCallView.js';
import { displayWidth } from '../../src/tui/text-measure.js';
import type { DisplayToolCall } from '../../src/tui/display-types.js';

// tui-redesign 08: diff rows carry a 4-wide line-number gutter, full-line
// backgrounds (theme tokens; ANSI is off in test frames so structure is
// asserted here), and never overflow the terminal width.

describe('diff line numbers (tui-redesign 08)', () => {
  it('numbers removals by old position and additions by new position', () => {
    const view = buildDiffView(
      { path: 'a.ts', old_string: 'x\ny', new_string: 'p\nq\nr' },
      'edit',
    );
    expect(view).not.toBeNull();
    const dels = view!.lines.filter((l) => l.kind === 'del');
    const adds = view!.lines.filter((l) => l.kind === 'add');
    expect(dels.map((l) => l.oldNo)).toEqual([1, 2]);
    expect(adds.map((l) => l.newNo)).toEqual([1, 2, 3]);
  });
});

describe('expanded diff rendering (tui-redesign 08)', () => {
  const call: DisplayToolCall = {
    id: 't1',
    name: 'edit_file',
    arguments: JSON.stringify({ path: 'a.ts', old_string: 'old line', new_string: 'new line' }),
    status: 'done',
  };
  const kindOf = (n: string) => (n === 'edit_file' ? { kind: 'path' as const, diff: 'edit' as const } : undefined);

  it('shows the marker, number gutter and text', () => {
    const frame = render(<ToolCallView toolCall={call} expanded displayKind={kindOf} />).lastFrame() ?? '';
    expect(frame).toContain('- old line');
    expect(frame).toContain('+ new line');
    // 4-wide right-aligned numbers present for both rows
    expect(frame).toMatch(/\s1 [-+] /);
  });

  it('truncates over-long lines to the terminal width', () => {
    const wide: DisplayToolCall = {
      ...call,
      arguments: JSON.stringify({ path: 'a.ts', old_string: '', new_string: 'x'.repeat(400) }),
    };
    const frame = render(<ToolCallView toolCall={wide} expanded displayKind={kindOf} />).lastFrame() ?? '';
    for (const line of frame.split('\n')) {
      expect(displayWidth(line)).toBeLessThanOrEqual(100);
    }
    expect(frame).toContain('...');
  });
});
