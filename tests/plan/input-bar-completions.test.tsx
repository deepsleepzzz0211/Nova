import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import React from 'react';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { InputBar } from '../../src/tui/InputBar.js';
import { render } from 'ink-testing-library';

let root: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-cmpl-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'x');
  fs.writeFileSync(path.join(root, 'README.md'), 'x');
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function settle(ms = 50): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('InputBar completions (tui-refactor 03, component)', () => {
  it('slash: typing / shows the command list; Tab accepts into the editor', async () => {
    const onSubmit = vi.fn();
    const instance = render(
      <InputBar onSubmit={onSubmit} isStreaming={false} fileIndexRoot={root} />,
    );
    instance.stdin.write('/');
    await settle();
    expect(instance.lastFrame()).toContain('/model — list or switch models');
    expect(instance.lastFrame()).toContain('/undo');

    instance.stdin.write('\t'); // Tab accepts the first match
    await settle();
    expect(instance.lastFrame()).toContain('/model ');
    expect(instance.lastFrame()).not.toContain('/undo —');
    instance.unmount();
  });

  it('slash: typing filters the list; arrow keys move selection; Enter accepts', async () => {
    const onSubmit = vi.fn();
    const instance = render(
      <InputBar onSubmit={onSubmit} isStreaming={false} fileIndexRoot={root} />,
    );
    instance.stdin.write('/u');
    await settle();
    expect(instance.lastFrame()).toContain('/undo');
    expect(instance.lastFrame()).toContain('/update');

    instance.stdin.write('\x1b[B'); // down: second item
    instance.stdin.write('\r'); // Enter accepts (does not submit)
    await settle();
    expect(instance.lastFrame()).toContain('/update ');
    expect(onSubmit).not.toHaveBeenCalled();
    instance.unmount();
  });

  it('file: @ triggers fuzzy completion; Tab inserts the path', async () => {
    const onSubmit = vi.fn();
    const instance = render(
      <InputBar onSubmit={onSubmit} isStreaming={false} fileIndexRoot={root} />,
    );
    instance.stdin.write('check @ma');
    // Wait until the lazy file index walk completes and the list shows up.
    for (let i = 0; i < 40 && !(instance.lastFrame() ?? '').includes('src/main.ts'); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(instance.lastFrame()).toContain('src/main.ts');

    instance.stdin.write('\t');
    await settle();
    expect(instance.lastFrame()).toContain('src/main.ts');
    expect(instance.lastFrame()).not.toContain('README');
    instance.unmount();
  });

  it('Esc closes an open completion list', async () => {
    const onInterrupt = vi.fn();
    const instance = render(
      <InputBar onSubmit={() => {}} isStreaming={false} onInterrupt={onInterrupt} fileIndexRoot={root} />,
    );
    instance.stdin.write('/');
    await settle();
    expect(instance.lastFrame()).toContain('/model —');
    instance.stdin.write('\x1b'); // Esc closes the completion (not interrupt: not streaming)
    await settle();
    expect(instance.lastFrame()).not.toContain('/model —');
    expect(onInterrupt).not.toHaveBeenCalled();
    instance.unmount();
  });

  it('large pasted multi-line content folds into a placeholder and expands on submit', async () => {
    const onSubmit = vi.fn();
    const instance = render(
      <InputBar onSubmit={onSubmit} isStreaming={false} fileIndexRoot={root} />,
    );
    const body = Array.from({ length: 15 }, (_, i) => `L${i}`).join('\n');
    instance.stdin.write('data:\n' + body + '\n');
    await settle();
    // Placeholder visible, body hidden
    expect(instance.lastFrame()).toContain('[paste #1 +');
    expect(instance.lastFrame()).not.toContain('L14');

    instance.stdin.write('\r');
    await settle();
    expect(onSubmit).toHaveBeenCalledWith('data:\n' + body + '\n');
    instance.unmount();
  });

  it('small pasted content inserts directly without folding', async () => {
    const onSubmit = vi.fn();
    const instance = render(
      <InputBar onSubmit={onSubmit} isStreaming={false} fileIndexRoot={root} />,
    );
    instance.stdin.write('a\nb\nc');
    await settle();
    expect(instance.lastFrame()).not.toContain('[paste');
    instance.stdin.write('\r');
    await settle();
    expect(onSubmit).toHaveBeenCalledWith('a\nb\nc');
    instance.unmount();
  });
});

describe('Enter semantics with an open completion (E2E finding)', () => {
  it('submits when the typed text already equals the completion', async () => {
    const onSubmit = vi.fn();
    const instance = render(
      <InputBar onSubmit={onSubmit} isStreaming={false} fileIndexRoot={root} />,
    );
    instance.stdin.write('/model');
    await settle();
    expect(instance.lastFrame()).toContain('/model — list or switch models');
    instance.stdin.write('\r'); // Enter must submit, not accept
    await settle();
    expect(onSubmit).toHaveBeenCalledWith('/model');
    instance.unmount();
  });

  it('accepts the completion when it adds something (partial match)', async () => {
    const onSubmit = vi.fn();
    const instance = render(
      <InputBar onSubmit={onSubmit} isStreaming={false} fileIndexRoot={root} />,
    );
    instance.stdin.write('/mod');
    await settle();
    instance.stdin.write('\r');
    await settle();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain('/model ');
    instance.unmount();
  });
});
