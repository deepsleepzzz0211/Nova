import { describe, it, expect, vi } from 'vitest';
import { CompletionController } from '../../src/tui/completion-controller.js';

function makeController(files: string[] = ['src/main.ts', 'src/other.ts']) {
  const states: Array<unknown> = [];
  const loadFiles = vi.fn(async () => files);
  const controller = new CompletionController({
    commands: (query) => CompletionController.commandItems(query),
    loadFiles,
    onChange: (state) => states.push(state),
  });
  return { controller, loadFiles, states };
}

describe('completion controller (tui-refactor 17)', () => {
  it('resolves slash completions synchronously from the registry', () => {
    const { controller } = makeController();
    controller.refresh('/mod', 4);
    expect(controller.current?.items[0].insert).toBe('/model ');
    expect(controller.current?.index).toBe(0);
  });

  it('closes when the text no longer triggers a completion', () => {
    const { controller } = makeController();
    controller.refresh('/mod', 4);
    expect(controller.current).toBeDefined();
    controller.refresh('/model done ', 12);
    expect(controller.current).toBeUndefined();
  });

  it('loads the file index lazily and recomputes once it arrives', async () => {
    const { controller, loadFiles } = makeController();
    controller.refresh('look at @ma', 11);
    // Nothing to show until the index resolves, and it is only loaded once.
    expect(controller.current).toBeUndefined();
    expect(loadFiles).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(controller.current?.items.map((item) => item.insert)).toEqual(['src/main.ts']);

    controller.refresh('look at @o', 10);
    await new Promise((r) => setTimeout(r, 0));
    expect(controller.current?.items.map((item) => item.insert)).toEqual(['src/other.ts']);
    expect(loadFiles).toHaveBeenCalledTimes(1); // cached
  });

  it('moves the highlight and clamps at both ends', () => {
    const { controller } = makeController();
    controller.refresh('/u', 2); // undo + update
    expect(controller.current?.items.length).toBe(2);
    controller.move(5);
    expect(controller.current?.index).toBe(1);
    controller.move(-5);
    expect(controller.current?.index).toBe(0);
  });

  it('accept returns the token range and insert text, or null when closed', () => {
    const { controller } = makeController();
    expect(controller.accept()).toBeNull();
    controller.refresh('/mod', 4);
    expect(controller.accept()).toEqual({ tokenStart: 0, end: 4, insert: '/model ' });
    controller.close();
    expect(controller.accept()).toBeNull();
  });

  it('wouldChangeText is false for an exact command match (Enter submits)', () => {
    const { controller } = makeController();
    controller.refresh('/model', 6);
    expect(controller.wouldChangeText('/model')).toBe(false);
    controller.refresh('/mod', 4);
    expect(controller.wouldChangeText('/mod')).toBe(true);
  });

  it('notifies the component on every state change', () => {
    const { controller, states } = makeController();
    controller.refresh('/mod', 4);
    controller.move(1);
    controller.close();
    expect(states.length).toBe(3);
    expect(states.at(-1)).toBeUndefined();
  });
});
