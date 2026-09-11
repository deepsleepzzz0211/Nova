/**
 * Theme tokens (tui-refactor ticket 11): every colour the TUI uses is named
 * here, so a component never hardcodes one and a future theme switcher only
 * touches this file. Names follow the pi-style vocabulary (border, muted,
 * toolDiffAdded, mdHeading, …).
 *
 * Values are Ink colour names/hex strings, so they can be swapped for a
 * light/dark palette without touching components.
 */
export const theme = {
  /** Brand accent: headings, model name, active selection. */
  primary: 'cyan',
  /** Secondary accent: subagent activity, thinking emphasis. */
  secondary: 'magenta',

  border: 'gray',
  borderAccent: 'cyan',

  success: 'green',
  error: 'red',
  warning: 'yellow',
  /** Dim/secondary text: hints, metadata, status labels. */
  muted: 'gray',

  userMessage: 'blue',
  assistantMessage: 'white',
  /** Reasoning stream (dim italic in the renderer). */
  thinking: 'gray',
  systemNotice: 'gray',

  toolTitle: 'yellow',
  toolOutput: 'white',
  toolPending: 'yellow',
  toolSuccess: 'green',
  toolError: 'red',

  diffAdded: 'green',
  diffRemoved: 'red',
  diffContext: 'gray',
  diffHeader: 'gray',

  mdHeading: 'cyan',
  mdCode: 'gray',
  mdListBullet: 'gray',
  mdQuote: 'gray',
  mdTableHeader: 'cyan',

  /** Editor border doubles as the working indicator. */
  working: {
    idle: 'cyan',
    streaming: 'yellow',
    thinking: 'magenta',
  },

  /** highlight.js class groups → colour. */
  syntax: {
    keyword: 'magenta',
    string: 'green',
    comment: 'gray',
    number: 'yellow',
    title: 'cyan',
  },
} as const;

export type Theme = typeof theme;
