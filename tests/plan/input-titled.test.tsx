import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { InputBar } from '../../src/tui/InputBar.js';

// tui-redesign 03: title-in-border ` Input `, accent-reactive edges, an
// inner model/thought status row, `> ` completion selector, new placeholder.

async function settle(ms = 40): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function bar(extra: Partial<React.ComponentProps<typeof InputBar>> = {}) {
  const { onSubmit = vi.fn(), isStreaming = false, ...rest } = extra;
  return render(<InputBar onSubmit={onSubmit} isStreaming={isStreaming} {...rest} />);
}

describe('InputBar titled border (tui-redesign 03)', () => {
  it('embeds the Input title in the top edge and closes the box', () => {
    const frame = bar().lastFrame() ?? '';
    expect(frame).toContain('╭─ Input');
    expect(frame).toContain('╮');
    expect(frame).toContain('╰');
    expect(frame).toContain('╯');
  });

  it('uses the new placeholder', () => {
    expect(bar().lastFrame() ?? '').toContain('Type a prompt');
  });

  it('keeps the working placeholder while streaming', () => {
    const frame = bar({ isStreaming: true, workingState: 'streaming' }).lastFrame() ?? '';
    expect(frame).toContain('(working… — you can still type)');
  });

  it('renders the inner model/thought status row when model info is given', () => {
    const frame = bar({
      modelInfo: { providerName: 'opencode-go', model: 'GLM-4.7', thinkingLevel: 'high' },
    }).lastFrame() ?? '';
    expect(frame).toContain('opencode-go/GLM-4.7');
    expect(frame).toContain('thought: high');
  });

  it('omits the status row without model info', () => {
    expect(bar().lastFrame() ?? '').not.toContain('thought:');
  });

  it('marks the selected completion item with the > selector', async () => {
    const instance = bar();
    instance.stdin.write('/');
    await settle();
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('> /model');
    // the non-selected rows are indented two columns
    expect(frame).toContain('  /undo');
    instance.unmount();
  });
});
