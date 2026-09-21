/**
 * Theme tokens (tui-refactor ticket 11; hex palette from tui-redesign 01):
 * every colour the TUI uses is named here, so a component never hardcodes one
 * and a theme switcher only touches this file.
 *
 * Values are truecolor hex (ZCode-style): foreground tokens are named by
 * role, and surface tokens (bg/panel/element/userBand/diff*Bgs) back the
 * background-coloured elements — user-message bands, diff lines, panels.
 * Ink renders these with ANSI-24bit; dim emphasis stays `dimColor`, never a
 * colour token.
 */
export const theme = {
  /** Brand accent: headings, model name, active selection. */
  primary: '#7dd3fc',
  /** Secondary accent: subagent activity, thinking emphasis. */
  secondary: '#c4b5fd',

  /** Foreground default text colour. */
  text: '#e5e7eb',
  /** App background (panels sit one step brighter). */
  bg: '#0f1419',
  /** Bordered chrome surfaces: input box, approval panel, popups. */
  panel: '#161b22',
  /** Raised elements inside a panel: code blocks, inline code. */
  element: '#1f2937',
  /** Background band behind user messages. */
  userBand: '#30363d',

  border: '#3b4450',
  borderActive: '#7dd3fc',
  borderSubtle: '#26313d',

  success: '#86efac',
  error: '#fca5a5',
  warning: '#fbbf24',
  /** Dim/secondary text: hints, metadata, status labels. */
  muted: '#94a3b8',

  userMessage: '#e5e7eb',
  assistantMessage: '#e5e7eb',
  /** Reasoning stream (dim italic in the renderer). */
  thinking: '#94a3b8',
  systemNotice: '#94a3b8',

  toolTitle: '#7dd3fc',
  toolOutput: '#e5e7eb',
  toolPending: '#fbbf24',
  toolSuccess: '#86efac',
  toolError: '#fca5a5',

  diffAdded: '#86efac',
  diffRemoved: '#fca5a5',
  diffContext: '#94a3b8',
  diffHeader: '#94a3b8',
  /** Full-line backgrounds for added/removed diff rows. */
  diffAddedBg: '#12351e',
  diffRemovedBg: '#3b1d17',

  mdHeading: '#7dd3fc',
  mdCode: '#94a3b8',
  mdListBullet: '#7dd3fc',
  mdQuote: '#94a3b8',
  mdTableHeader: '#7dd3fc',

  /** Editor border doubles as the working indicator. */
  working: {
    idle: '#7dd3fc',
    streaming: '#fbbf24',
    thinking: '#c4b5fd',
  },

  /** highlight.js class groups → colour. */
  syntax: {
    keyword: '#c4b5fd',
    string: '#86efac',
    comment: '#94a3b8',
    number: '#fbbf24',
    title: '#7dd3fc',
  },
} as const;

export type Theme = typeof theme;
