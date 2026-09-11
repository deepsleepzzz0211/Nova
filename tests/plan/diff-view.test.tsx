import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { buildDiffView, foldDiff } from '../../src/tui/diff-view.js';
import { ToolCallView } from '../../src/tui/ToolCallView.js';
import type { DisplayToolCall } from '../../src/tui/display-types.js';

describe('diff view (tui-refactor 06)', () => {
  describe('buildDiffView', () => {
    it('renders an edit as removed then added lines with a header', () => {
      const view = buildDiffView(
        { path: 'src/a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;\nconst b = 3;' },
        'edit',
      );
      expect(view).not.toBeNull();
      expect(view?.header).toBe('edit src/a.ts (+2 -1)');
      expect(view?.lines).toEqual([
        { kind: 'del', text: 'const a = 1;' },
        { kind: 'add', text: 'const a = 2;' },
        { kind: 'add', text: 'const b = 3;' },
      ]);
      expect(view?.removed).toBe(1);
      expect(view?.added).toBe(2);
    });

    it('renders a write as additions and reports append mode', () => {
      const view = buildDiffView({ path: 'notes.md', content: 'one\ntwo' }, 'write');
      expect(view?.header).toBe('write notes.md (+2 -0)');
      expect(view?.lines.every((line) => line.kind === 'add')).toBe(true);

      const append = buildDiffView({ path: 'notes.md', content: 'three', mode: 'append' }, 'write');
      expect(append?.header).toBe('append notes.md (+1 -0)');
      expect(append?.lines).toEqual([{ kind: 'add', text: 'three' }]);
    });

    it('ignores a trailing newline instead of adding a phantom line', () => {
      const view = buildDiffView({ path: 'a', content: 'one\n' }, 'write');
      expect(view?.lines).toHaveLength(1);
    });

    it('returns null when the arguments carry no text', () => {
      expect(buildDiffView(null, 'edit')).toBeNull();
      expect(buildDiffView({ path: 'a' }, 'edit')).toBeNull();
    });
  });

  describe('foldDiff', () => {
    it('caps the rendered lines and reports the hidden count', () => {
      const view = buildDiffView({ path: 'a', content: Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n') }, 'write');
      const folded = foldDiff(view!, 30);
      expect(folded.lines).toHaveLength(30);
      expect(folded.hidden).toBe(10);
    });

    it('leaves short diffs untouched', () => {
      const view = buildDiffView({ path: 'a', content: 'x' }, 'write');
      expect(foldDiff(view!, 30).hidden).toBe(0);
    });
  });
});

describe('ToolCallView diff rendering (ticket 06)', () => {
  const displayFor = (name: string): { kind: 'command' | 'path'; diff?: 'edit' | 'write' } | undefined => {
    if (name === 'edit_file') return { kind: 'path', diff: 'edit' };
    if (name === 'write_file') return { kind: 'path', diff: 'write' };
    if (name === 'bash') return { kind: 'command' };
    return undefined;
  };

  const call = (name: string, args: Record<string, unknown>): DisplayToolCall => ({
    id: 'c1',
    name,
    arguments: JSON.stringify(args),
    status: 'done',
  });

  it('shows added and removed lines for an edit instead of raw JSON', () => {
    const instance = render(
      <ToolCallView
        toolCall={call('edit_file', { path: 'a.ts', old_string: 'old line', new_string: 'new line' })}
        expanded={true}
        displayKind={displayFor}
      />,
    );
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('edit a.ts (+1 -1)');
    expect(frame).toContain('- old line');
    expect(frame).toContain('+ new line');
    expect(frame).not.toContain('old_string');
    instance.unmount();
  });

  it('renders a write as additions', () => {
    const instance = render(
      <ToolCallView
        toolCall={call('write_file', { path: 'notes.md', content: 'hello' })}
        expanded={true}
        displayKind={displayFor}
      />,
    );
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('write notes.md (+1 -0)');
    expect(frame).toContain('+ hello');
    instance.unmount();
  });

  it('keeps the JSON view for tools without a diff mode', () => {
    const instance = render(
      <ToolCallView
        toolCall={call('bash', { command: 'ls' })}
        expanded={true}
        displayKind={displayFor}
      />,
    );
    expect(instance.lastFrame()).toContain('"command"');
    instance.unmount();
  });
});
