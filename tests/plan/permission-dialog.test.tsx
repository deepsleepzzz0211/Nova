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

describe('PermissionDialog options list (tui-refactor 04)', () => {
  it('transitions null -> pending -> null without hook-order crashes', () => {
    const pending = makePending('bash', JSON.stringify({ command: 'ls' }));
    const { lastFrame, rerender } = render(<PermissionDialog pending={null} />);
    expect(lastFrame()).not.toContain('Permission Required');

    rerender(<PermissionDialog pending={pending} />);
    expect(lastFrame()).toContain('Permission Required');
    expect(lastFrame()).toContain('bash');

    rerender(<PermissionDialog pending={null} />);
    expect(lastFrame()).not.toContain('Permission Required');
  });

  it('shows the three numbered options and a typed description (no raw JSON)', () => {
    const pending = makePending('bash', JSON.stringify({ command: 'npm test' }));
    const { lastFrame } = render(<PermissionDialog pending={pending} />);
    expect(lastFrame()).toContain('1. No');
    expect(lastFrame()).toContain('2. Yes');
    expect(lastFrame()).toContain('3. Yes, always (this session)');
    expect(lastFrame()).toContain('npm test'); // typed description
    expect(lastFrame()).not.toContain('{"command"');
  });

  it('number keys pick directly: 2=allow, 1=deny, 3=always', async () => {
    const allow = makePending('bash', JSON.stringify({ command: 'ls' }));
    const { stdin, rerender } = render(<PermissionDialog pending={allow} />);
    stdin.write('2');
    await new Promise((r) => setTimeout(r, 20));
    expect(allow.resolve).toHaveBeenCalledWith('allow');

    const deny = makePending('bash', JSON.stringify({ command: 'ls' }));
    rerender(<PermissionDialog pending={deny} />);
    stdin.write('1');
    await new Promise((r) => setTimeout(r, 20));
    expect(deny.resolve).toHaveBeenCalledWith('deny');

    const always = makePending('bash', JSON.stringify({ command: 'ls' }));
    rerender(<PermissionDialog pending={always} />);
    stdin.write('3');
    await new Promise((r) => setTimeout(r, 20));
    expect(always.resolve).toHaveBeenCalledWith('always');
  });

  it('arrows + Enter pick the highlighted option', async () => {
    const pending = makePending('bash', JSON.stringify({ command: 'ls' }));
    const { stdin } = render(<PermissionDialog pending={pending} />);
    stdin.write('\x1b[B'); // down: second option (Yes)
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 30));
    expect(pending.resolve).toHaveBeenCalledWith('allow');
  });

  it('Esc resolves deny', async () => {
    const pending = makePending('bash', JSON.stringify({ command: 'ls' }));
    const { stdin } = render(<PermissionDialog pending={pending} />);
    stdin.write('\x1b');
    await new Promise((r) => setTimeout(r, 30));
    expect(pending.resolve).toHaveBeenCalledWith('deny');
  });

  it('dangerous commands show the reason with a red border', () => {
    const pending = makePending('bash', JSON.stringify({ command: 'rm -rf /tmp/x' }));
    const { lastFrame } = render(<PermissionDialog pending={pending} />);
    expect(lastFrame()).toContain('Recursive file deletion');
  });

  it('ignores keys while no request is pending (no resolution)', () => {
    const pending = makePending('bash', JSON.stringify({ command: 'ls' }));
    const instance = render(<PermissionDialog pending={null} />);
    instance.stdin.write('1');
    instance.stdin.write('2');
    instance.stdin.write('3');
    expect(pending.resolve).not.toHaveBeenCalled();

    instance.rerender(<PermissionDialog pending={pending} />);
    expect(instance.lastFrame()).toContain('Permission Required');
    instance.unmount();
  });
});

describe('PermissionDialog safety (review fixes)', () => {
  it('dangerous calls do not offer the always option', () => {
    const pending = makePending('bash', JSON.stringify({ command: 'rm -rf /tmp/x' }));
    const { lastFrame } = render(<PermissionDialog pending={pending} />);
    expect(lastFrame()).toContain('Recursive file deletion');
    expect(lastFrame()).toContain('1. No');
    expect(lastFrame()).toContain('2. Yes');
    expect(lastFrame()).not.toContain('3. Yes, always');
  });

  it('selection resets when a new request arrives (no stale always)', async () => {
    const first = makePending('bash', JSON.stringify({ command: 'ls' }));
    const second = makePending('bash', JSON.stringify({ command: 'pwd' }));
    const { stdin, rerender } = render(<PermissionDialog pending={first} />);
    stdin.write('\x1b[B'); // down -> option 2
    stdin.write('\x1b[B'); // down -> option 3 (always)
    rerender(<PermissionDialog pending={second} />); // new request
    stdin.write('\r'); // Enter must hit option 1 (No), NOT always
    await new Promise((r) => setTimeout(r, 30));
    expect(second.resolve).toHaveBeenCalledWith('deny');
  });
});
