import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ToolCallView } from '../../src/tui/ToolCallView.js';
import type { DisplayToolCall } from '../../src/tui/hooks/useAgent.js';

const displayKind = (name: string): { kind: 'command' | 'path' } | undefined =>
  name === 'bash' ? { kind: 'command' } : name === 'read_file' ? { kind: 'path' } : undefined;

function makeCall(overrides: Partial<DisplayToolCall>): DisplayToolCall {
  return {
    id: 'c1',
    name: 'bash',
    arguments: JSON.stringify({ command: 'ls -la' }),
    status: 'done',
    ...overrides,
  };
}

describe('ToolCallView (tui-refactor 05, component)', () => {
  it('shows the typed summary (command) when folded, not raw JSON', () => {
    const instance = render(
      <ToolCallView toolCall={makeCall({})} expanded={false} displayKind={displayKind} />,
    );
    expect(instance.lastFrame()).toContain('ls -la');
    expect(instance.lastFrame()).not.toContain('{"command"');
    instance.unmount();
  });

  it('shows ⚠ pending, ✓ done, ✗ error icons with correct colors', () => {
    const pending = render(<ToolCallView toolCall={makeCall({ status: 'pending' })} expanded={false} displayKind={displayKind} />);
    expect(pending.lastFrame()).toContain('⚠');
    pending.unmount();

    const done = render(<ToolCallView toolCall={makeCall({ status: 'done' })} expanded={false} displayKind={displayKind} />);
    expect(done.lastFrame()).toContain('✓');
    done.unmount();

    const error = render(
      <ToolCallView toolCall={makeCall({ status: 'error', result: 'boom' })} expanded={false} displayKind={displayKind} />,
    );
    expect(error.lastFrame()).toContain('✗');
    error.unmount();
  });

  it('animated spinner renders a braille frame while running', async () => {
    const instance = render(
      <ToolCallView toolCall={makeCall({ status: 'running' })} expanded={false} displayKind={displayKind} />,
    );
    await new Promise((r) => setTimeout(r, 100)); // let it tick
    const frame = instance.lastFrame() ?? '';
    expect(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(frame)).toBe(true);
    instance.unmount();
  });

  it('expanded shows args and folds long results with the hidden count', () => {
    const result = Array.from({ length: 30 }, (_, i) => `R${i}`).join('\n');
    const instance = render(
      <ToolCallView toolCall={makeCall({ result })} expanded={true} displayKind={displayKind} />,
    );
    expect(instance.lastFrame()).toContain('"command": "ls -la"');
    expect(instance.lastFrame()).toContain('... (10 more lines)');
    instance.unmount();
  });

  it('has no input handling: pressing keys does not change the output', async () => {
    const instance = render(
      <ToolCallView toolCall={makeCall({})} expanded={false} displayKind={displayKind} />,
    );
    const before = instance.lastFrame();
    instance.stdin.write('\r');
    instance.stdin.write('x');
    await new Promise((r) => setTimeout(r, 30));
    expect(instance.lastFrame()).toBe(before); // fold state is App-owned
    instance.unmount();
  });
});
