import { detectCompletion, completeCommands, fuzzyMatchFiles, type CompletionContext } from './completions.js';

/**
 * Completion popup state machine (tui-refactor ticket 17), extracted from
 * InputBar so it can be unit-tested without React:
 *  - slash commands resolve synchronously from the registry
 *  - the @ file index is loaded lazily and the popup recomputed once it
 *    arrives (the component only renders what this controller reports)
 */
export interface CompletionItem {
  label: string;
  insert: string;
}

export interface ActiveCompletion {
  ctx: CompletionContext;
  items: CompletionItem[];
  index: number;
}

export interface CompletionDeps {
  /** Command completions for a query (registry-backed). */
  commands: (query: string) => CompletionItem[];
  /** Load (and cache) the file index; called at most once per controller. */
  loadFiles: () => Promise<string[]>;
  /** Notified whenever the popup state changes (undefined = closed). */
  onChange: (state: ActiveCompletion | undefined) => void;
}

export class CompletionController {
  private state: ActiveCompletion | undefined;
  private files: string[] | undefined;
  private loading = false;
  /** Last text/cursor seen, so an async index load can recompute. */
  private last: { text: string; cursor: number } = { text: '', cursor: 0 };

  constructor(private readonly deps: CompletionDeps) {}

  get current(): ActiveCompletion | undefined {
    return this.state;
  }

  /** Recompute the popup after the editor text/cursor changed. */
  refresh(text: string, cursor: number): void {
    this.last = { text, cursor };
    const ctx = detectCompletion(text, cursor);
    if (ctx === null) {
      this.set(undefined);
      return;
    }

    if (ctx.kind === 'slash') {
      const items = this.deps.commands(ctx.query);
      this.set({ ctx, items, index: 0 });
      return;
    }

    // @ file completion needs the index; kick off the load and recompute.
    if (this.files === undefined) {
      if (!this.loading) {
        this.loading = true;
        void this.deps.loadFiles().then((files) => {
          this.files = files;
          this.loading = false;
          this.refresh(this.last.text, this.last.cursor);
        });
      }
      return;
    }
    const items = fuzzyMatchFiles(this.files, ctx.query).map((file) => ({ label: file, insert: file }));
    this.set({ ctx, items, index: 0 });
  }

  /** Highlight a specific item (pointer interaction), clamped. */
  select(index: number): void {
    const state = this.state;
    if (state === undefined || state.items.length === 0) return;
    this.set({ ...state, index: Math.max(0, Math.min(state.items.length - 1, index)) });
  }

  /** Move the highlighted item, clamped to the list. */
  move(delta: number): void {
    const state = this.state;
    if (state === undefined || state.items.length === 0) return;
    const next = Math.max(0, Math.min(state.items.length - 1, state.index + delta));
    this.set({ ...state, index: next });
  }

  /**
   * Accept the highlighted item. Returns the token range to replace, or null
   * when nothing is open (the caller applies it to its editor state).
   */
  accept(): { tokenStart: number; end: number; insert: string } | null {
    const state = this.state;
    if (state === undefined) return null;
    const item = state.items[state.index];
    if (item === undefined) return null;
    return { tokenStart: state.ctx.tokenStart, end: state.ctx.tokenStart + state.ctx.query.length + 1, insert: item.insert };
  }

  /** Close the popup (Esc, or after accepting). */
  close(): void {
    this.set(undefined);
  }

  /**
   * Enter must submit rather than accept when the highlighted completion adds
   * nothing (typing an exact command name) — the E2E finding behind the
   * "exact match submits" rule.
   */
  wouldChangeText(text: string): boolean {
    const state = this.state;
    if (state === undefined) return false;
    const item = state.items[state.index];
    if (item === undefined) return false;
    return item.insert.trimEnd() !== text.trimEnd();
  }

  /** Slash-completion items, shaped like the registry's command list. */
  static commandItems(query: string): CompletionItem[] {
    return completeCommands(query).map((command) => ({
      label: `/${command.name} — ${command.description}`,
      insert: command.acceptsArgs ? `/${command.name} ` : `/${command.name}`,
    }));
  }

  private set(state: ActiveCompletion | undefined): void {
    this.state = state;
    this.deps.onChange(state);
  }
}
