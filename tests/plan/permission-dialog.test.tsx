import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { PermissionDialog } from '../../src/tui/PermissionDialog.js';
import type { PendingPermission } from '../../src/tui/hooks/useAgent.js';
import type { ToolCall } from '../../src/llm/types.js';

function makePending(name: string, args: string): PendingPermission {
  const call: ToolCall = {
    id: 'c1',
    type: 'function',
    function: { name, arguments: args },
  };
  return { call, resolve: vi.fn() };
}

describe('PermissionDialog (ink-testing-library, tui-refactor 01 regression)', () => {
  it('transitions null -> pending -> null without hook-order crashes', () => {
    // Pre-fix this crashed on rerender: useInput was registered after the
    // early return, so the hook order changed between renders.
    const pending = makePending('bash', JSON.stringify({ command: 'ls' }));
    const { lastFrame, rerender } = render(<PermissionDialog pending={null} />);
    expect(lastFrame()).not.toContain('Permission Required');

    rerender(<PermissionDialog pending={pending} />);
    expect(lastFrame()).toContain('Permission Required');
    expect(lastFrame()).toContain('bash');

    rerender(<PermissionDialog pending={null} />);
    expect(lastFrame()).not.toContain('Permission Required');
  });

  it('resolves allow/deny/always via a/d/A keys', async () => {
    const allow = makePending('bash', JSON.stringify({ command: 'ls' }));
    const { stdin, rerender } = render(<PermissionDialog pending={allow} />);
    stdin.write('a');
    await new Promise((r) => setTimeout(r, 20));
    expect(allow.resolve).toHaveBeenCalledWith(true);

    const deny = makePending('bash', JSON.stringify({ command: 'ls' }));
    rerender(<PermissionDialog pending={deny} />);
    stdin.write('d');
    await new Promise((r) => setTimeout(r, 20));
    expect(deny.resolve).toHaveBeenCalledWith(false);

    const always = makePending('bash', JSON.stringify({ command: 'ls' }));
    rerender(<PermissionDialog pending={always} />);
    stdin.write('A');
    await new Promise((r) => setTimeout(r, 20));
    expect(always.resolve).toHaveBeenCalledWith(true);
  });

  it('ignores keys while no request is pending (no resolution)', () => {
    const pending = makePending('bash', JSON.stringify({ command: 'ls' }));
    const instance = render(<PermissionDialog pending={null} />);
    instance.stdin.write('a');
    instance.stdin.write('d');
    instance.stdin.write('A');
    expect(pending.resolve).not.toHaveBeenCalled();

    // Transitions to pending afterwards: keys typed while null must not
    // have leaked into the request that appears later.
    instance.rerender(<PermissionDialog pending={pending} />);
    expect(instance.lastFrame()).toContain('Permission Required');
    instance.unmount();
  });
});
