import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import {
  toolVerb,
  tidyValue,
  formatDurationMs,
  summarizeCall,
  groupToolCalls,
} from '../../src/tui/tool-summary.js';
import { ToolCallView } from '../../src/tui/ToolCallView.js';
import type { DisplayToolCall } from '../../src/tui/display-types.js';

// tui-redesign 05: status-coloured verb title + muted key:value detail +
// duration, [redacted]/[N chars] tidiness, and same-verb fold rows.

const call = (over: Partial<DisplayToolCall>): DisplayToolCall => ({
  id: 'c1',
  name: 'bash',
  arguments: JSON.stringify({ command: 'ls -la' }),
  status: 'done',
  ...over,
});

describe('tool verb mapping (tui-redesign 05)', () => {
  it('maps the built-in tools to display verbs', () => {
    expect(toolVerb('read_file')).toBe('Read');
    expect(toolVerb('write_file')).toBe('Write');
    expect(toolVerb('edit_file')).toBe('Edit');
    expect(toolVerb('bash')).toBe('Bash');
    expect(toolVerb('web_search')).toBe('Search');
    expect(toolVerb('web_fetch')).toBe('Fetch');
    expect(toolVerb('spawn_subagent')).toBe('Agent');
  });

  it('degrades unknown names to title-cased words', () => {
    expect(toolVerb('custom_tool')).toBe('Custom Tool');
  });
});

describe('summary tidiness (tui-redesign 05)', () => {
  it('redacts secret-shaped values and caps long ones', () => {
    // Assembled at runtime: the repo-wide secret scanner must not trip on
    // test fixtures that mimic key shapes by design.
    expect(tidyValue(`sk-${'abcdef1234567890'}`)).toBe('[redacted]');
    expect(tidyValue(`github_${'pat_11ABCDEF0123456789'}`)).toBe('[redacted]');
    expect(tidyValue('x'.repeat(70))).toBe('[70 chars]');
    expect(tidyValue('ls -la')).toBe('ls -la');
  });

  it('renders key: value pairs instead of raw JSON for non-primary args', () => {
    const s = summarizeCall('search_like', JSON.stringify({ pattern: 'foo', max_results: 5 }));
    expect(s).toContain('pattern: foo');
    expect(s).toContain('max_results: 5');
    expect(s).not.toContain('{');
  });

  it('formats durations like ZCode (sub-second ms, else one-decimal s)', () => {
    expect(formatDurationMs(123)).toBe('123ms');
    expect(formatDurationMs(1200)).toBe('1.2s');
    expect(formatDurationMs(65_400)).toBe('65.4s');
  });
});

describe('tool row rendering (tui-redesign 05)', () => {
  it('done call: status icon + verb + detail + duration', () => {
    const frame =
      render(
        <ToolCallView
          toolCall={call({ startedAtMs: 1_000, endedAtMs: 2_200 })}
          expanded={false}
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('✓ Bash');
    expect(frame).toContain('ls -la');
    expect(frame).toContain('1.2s');
  });

  it('error call keeps the verb but flips the icon', () => {
    const frame = render(<ToolCallView toolCall={call({ status: 'error' })} expanded={false} />).lastFrame() ?? '';
    expect(frame).toContain('✗ Bash');
  });
});

describe('same-verb fold (tui-redesign 05)', () => {
  const reads = [
    call({ id: 'a', name: 'read_file', arguments: JSON.stringify({ path: 'src/a.ts' }) }),
    call({ id: 'b', name: 'read_file', arguments: JSON.stringify({ path: 'src/b.ts' }) }),
    call({ id: 'c', name: 'read_file', arguments: JSON.stringify({ path: 'src/c.ts' }) }),
  ];

  it('folds consecutive finished same-verb calls into one group', () => {
    const rows = groupToolCalls(reads, () => false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'group', verb: 'Read', count: 3 });
  });

  it('does not fold while any member is live', () => {
    const live = reads.map((r, i) => (i === 1 ? { ...r, status: 'running' as const } : r));
    expect(groupToolCalls(live, () => false).every((r) => r.type === 'single')).toBe(true);
  });

  it('expanding any member expands the whole group', () => {
    const rows = groupToolCalls(reads, (id) => id === 'b');
    expect(rows).toHaveLength(3);
  });

  it('renders a group row with the latest detail', () => {
    const rows = groupToolCalls(reads, () => false);
    const g = rows[0];
    expect(g.type === 'group' && g.latestSummary).toContain('src/c.ts');
    expect(g.type === 'group' && g.count).toBe(3);
  });
});
