import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { InputBar } from '../../src/tui/InputBar.js';

// approval-flow 02: Ink's useInput is broadcast — while the permission
// modal owns the keyboard, the editor must swallow EVERY key (live
// acceptance caught the dialog's '2' leaking into the buffer).

async function settle(ms = 40): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('InputBar modal key isolation (approval-flow 02)', () => {
  it('ignores all keystrokes while a modal is open', async () => {
    const onSubmit = vi.fn();
    const instance = render(<InputBar onSubmit={onSubmit} isStreaming={false} modalOpen />);
    instance.stdin.write('2abc');
    await settle();
    instance.stdin.write('\t'); // Tab: no completion accept either
    instance.stdin.write('\r'); // Enter: must not submit
    await settle();
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('Type a prompt');
    expect(frame).not.toContain('2abc');
    expect(onSubmit).not.toHaveBeenCalled();
    instance.unmount();
  });

  it('restores normal editing once the modal closes', async () => {
    const onSubmit = vi.fn();
    const instance = render(<InputBar onSubmit={onSubmit} isStreaming={false} modalOpen />);
    instance.stdin.write('x');
    await settle();
    instance.rerender(<InputBar onSubmit={onSubmit} isStreaming={false} />);
    instance.stdin.write('hi');
    await settle();
    instance.stdin.write('\r');
    await settle();
    expect(onSubmit).toHaveBeenCalledWith('hi');
    instance.unmount();
  });
});
