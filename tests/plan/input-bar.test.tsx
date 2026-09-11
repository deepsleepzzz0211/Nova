import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { InputBar } from '../../src/tui/InputBar.js';

function typeText(stdin: { write: (s: string) => void }, text: string): void {
  stdin.write(text);
}

async function settle(ms = 30): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('InputBar multi-line editor (tui-refactor 02, component)', () => {
  it('types, edits, and submits on Enter', async () => {
    const onSubmit = vi.fn();
    const instance = render(<InputBar onSubmit={onSubmit} isStreaming={false} />);

    typeText(instance.stdin, 'hello');
    await settle();
    expect(instance.lastFrame()).toContain('hello');

    instance.stdin.write('\r'); // Enter submits
    await settle();
    expect(onSubmit).toHaveBeenCalledWith('hello');
    expect(instance.lastFrame()).toContain('Type a message');
    instance.unmount();
  });

  it('Ctrl+Enter (LF) inserts a newline and Enter submits the whole buffer', async () => {
    const onSubmit = vi.fn();
    const instance = render(<InputBar onSubmit={onSubmit} isStreaming={false} />);

    typeText(instance.stdin, 'line one');
    instance.stdin.write('\n'); // LF = Ctrl+Enter on Windows Terminal
    typeText(instance.stdin, 'line two');
    await settle();
    expect(instance.lastFrame()).toContain('line one');

    instance.stdin.write('\r');
    await settle();
    expect(onSubmit).toHaveBeenCalledWith('line one\nline two');
    instance.unmount();
  });

  it('backspace deletes, arrows move the cursor mid-string', async () => {
    const onSubmit = vi.fn();
    const instance = render(<InputBar onSubmit={onSubmit} isStreaming={false} />);

    typeText(instance.stdin, 'helo');
    instance.stdin.write('\x1b[D'); // left
    instance.stdin.write('\x1b[D'); // left
    typeText(instance.stdin, 'l'); // insert inside
    await settle();
    instance.stdin.write('\r');
    await settle();
    expect(onSubmit).toHaveBeenCalledWith('hello');
    instance.unmount();
  });

  it('up arrow recalls history, down returns to draft', async () => {
    const onSubmit = vi.fn();
    const instance = render(<InputBar onSubmit={onSubmit} isStreaming={false} />);

    typeText(instance.stdin, 'first');
    instance.stdin.write('\r');
    await settle();
    typeText(instance.stdin, 'draft');
    instance.stdin.write('\x1b[A'); // up -> recall 'first'
    await settle();
    expect(instance.lastFrame()).toContain('first');
    expect(instance.lastFrame()).not.toContain('draft');
    instance.stdin.write('\x1b[B'); // down -> back to draft
    await settle();
    expect(instance.lastFrame()).toContain('draft');
    instance.unmount();
  });

  it('Ctrl+W deletes the previous word', async () => {
    const onSubmit = vi.fn();
    const instance = render(<InputBar onSubmit={onSubmit} isStreaming={false} />);

    typeText(instance.stdin, 'hello world');
    instance.stdin.write('\x17'); // Ctrl+W
    await settle();
    instance.stdin.write('\r');
    await settle();
    expect(onSubmit).toHaveBeenCalledWith('hello ');
    instance.unmount();
  });

  it('Ctrl+C clears a non-empty editor and does not exit', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const onSubmit = vi.fn();
    const instance = render(<InputBar onSubmit={onSubmit} isStreaming={false} />);

    typeText(instance.stdin, 'draft');
    instance.stdin.write('\x03'); // Ctrl+C
    await settle(100);
    expect(instance.lastFrame()).toContain('Type a message');
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
    instance.unmount();
  });

  it('Esc while streaming fires onInterrupt and does not submit', async () => {
    const onInterrupt = vi.fn();
    const onSubmit = vi.fn();
    const instance = render(
      <InputBar onSubmit={onSubmit} isStreaming={true} onInterrupt={onInterrupt} />,
    );
    instance.stdin.write('\x1b');
    await settle();
    expect(onInterrupt).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    instance.unmount();
  });

  it('Enter while streaming does not submit', async () => {
    const onSubmit = vi.fn();
    const instance = render(<InputBar onSubmit={onSubmit} isStreaming={true} />);

    typeText(instance.stdin, 'queued thought');
    instance.stdin.write('\r');
    await settle();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain('queued thought'); // text kept
    instance.unmount();
  });
});

describe('InputBar working indicator (tui-refactor 09)', () => {
  it('shows the working placeholder for streaming and thinking states', async () => {
    const streaming = render(
      <InputBar onSubmit={() => {}} isStreaming={true} workingState="streaming" />,
    );
    expect(streaming.lastFrame()).toContain('working');
    streaming.unmount();

    const thinking = render(
      <InputBar onSubmit={() => {}} isStreaming={true} workingState="thinking" />,
    );
    expect(thinking.lastFrame()).toContain('working');
    thinking.unmount();
  });

  it('shows the idle placeholder when idle', () => {
    const instance = render(
      <InputBar onSubmit={() => {}} isStreaming={false} workingState="idle" />,
    );
    expect(instance.lastFrame()).toContain('Type a message');
    instance.unmount();
  });

  it('derives streaming state from isStreaming when workingState is omitted', () => {
    const instance = render(<InputBar onSubmit={() => {}} isStreaming={true} />);
    expect(instance.lastFrame()).toContain('working');
    instance.unmount();
  });
});

describe('coalesced input chunks (E2E finding)', () => {
  it('submits when text and Enter arrive in one stdin chunk', async () => {
    const onSubmit = vi.fn();
    const instance = render(<InputBar onSubmit={onSubmit} isStreaming={false} />);
    const CR = String.fromCharCode(13);
    instance.stdin.write('prompt delivered with the enter key' + CR);
    await settle();
    expect(onSubmit).toHaveBeenCalledWith('prompt delivered with the enter key');
    expect(instance.lastFrame()).toContain('Type a message');
    instance.unmount();
  });

  it('keeps a trailing newline inside a pasted block instead of submitting it', async () => {
    const onSubmit = vi.fn();
    const instance = render(<InputBar onSubmit={onSubmit} isStreaming={false} />);
    const LF = String.fromCharCode(10);
    instance.stdin.write('line one' + LF + 'line two' + LF);
    await settle();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain('line one');
    instance.unmount();
  });
});

describe('slash command submission with the completion popup (E2E finding)', () => {
  it('submits /undo when typed and Enter arrive separately', async () => {
    const onSubmit = vi.fn();
    const instance = render(<InputBar onSubmit={onSubmit} isStreaming={false} />);
    instance.stdin.write('/undo');
    await settle();
    instance.stdin.write(String.fromCharCode(13));
    await settle();
    expect(onSubmit).toHaveBeenCalledWith('/undo');
    instance.unmount();
  });

  it('submits /undo when text and Enter are coalesced', async () => {
    const onSubmit = vi.fn();
    const instance = render(<InputBar onSubmit={onSubmit} isStreaming={false} />);
    instance.stdin.write('/undo' + String.fromCharCode(13));
    await settle();
    expect(onSubmit).toHaveBeenCalledWith('/undo');
    instance.unmount();
  });
});

describe('Escape while a modal owns the keyboard (E2E finding)', () => {
  it('does not interrupt the stream when a permission dialog is open', async () => {
    const onInterrupt = vi.fn();
    const instance = render(
      <InputBar onSubmit={() => {}} isStreaming={true} modalOpen={true} onInterrupt={onInterrupt} />,
    );
    instance.stdin.write(String.fromCharCode(27));
    await settle();
    expect(onInterrupt).not.toHaveBeenCalled();
    instance.unmount();
  });

  it('still interrupts when no modal is open', async () => {
    const onInterrupt = vi.fn();
    const instance = render(
      <InputBar onSubmit={() => {}} isStreaming={true} modalOpen={false} onInterrupt={onInterrupt} />,
    );
    instance.stdin.write(String.fromCharCode(27));
    await settle();
    expect(onInterrupt).toHaveBeenCalled();
    instance.unmount();
  });
});
