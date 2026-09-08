import { describe, it, expect } from 'vitest';
import { formatSessionList } from '../../src/tui/SessionPicker.js';
import type { SessionSummary } from '../../src/agent/session.js';

describe('formatSessionList (--list output)', () => {
  it('prints "No sessions found." for an empty list', () => {
    expect(formatSessionList([])).toBe('No sessions found.');
  });

  it('formats stable, script-consumable lines (index, timestamp, count, preview)', () => {
    const sessions: SessionSummary[] = [
      { file: '/a.jsonl', mtimeMs: new Date('2026-09-08T09:30:00').getTime(), messageCount: 12, preview: 'fix the login bug' },
      { file: '/b.jsonl', mtimeMs: new Date('2026-09-07T23:05:00').getTime(), messageCount: 3, preview: '' },
    ];
    const out = formatSessionList(sessions);
    const lines = out.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(' 1. 2026-09-08 09:30');
    expect(lines[0]).toContain('  12 msgs');
    expect(lines[0]).toContain('fix the login bug');
    // Empty preview falls back to a placeholder
    expect(lines[1]).toContain('   3 msgs');
    expect(lines[1]).toContain('(no user messages)');
  });
});
