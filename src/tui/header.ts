/**
 * Welcome card (tui-redesign ticket 06): replaces the old plain-text startup
 * header that was printed before Ink took over. The card renders inside the
 * transcript's static region once — logo, session meta line (carrying the
 * info the retired top StatusBar used to pin) and one rotating tip. Pure
 * formatting here; the component just draws it.
 */

/** Session facts shown on the card's meta line. */
export interface WelcomeInfo {
  version: string;
  model: string;
  provider?: string;
  cwd: string;
  branch?: string | null;
  mcpCount: number;
}

/** What the view needs: logo rows + two muted lines. */
export interface WelcomeCard {
  logo: readonly string[];
  meta: string;
  tip: string;
}

/** Block-letter NOVA mark (ZCode-style ASCII logo). */
export const NOVA_LOGO: readonly string[] = [
  '███╗   ██╗ ██████╗ ██╗   ██╗ █████╗',
  '████╗  ██║██╔═══██╗██║   ██║██╔══██╗',
  '██╔██╗ ██║██║   ██║██║   ██║███████║',
  '██║╚██╗██║██║   ██║╚██╗ ██╔╝██╔══██║',
  '██║ ╚████║╚██████╔╝ ╚████╔╝ ██║  ██║',
  '╚═╝  ╚═══╝ ╚═════╝   ╚═══╝  ╚═╝  ╚═╝',
];

/** Tips double as the migrated hotkey documentation (ticket 06). */
const TIPS: readonly string[] = [
  'esc interrupts the response · ctrl+o expands the latest tool block',
  '@ references files · / lists commands · shift+enter adds a newline',
  '/model switches models · /status shows session info · /undo reverts turns',
  'ctrl+c clears the input; a second ctrl+c exits',
];

/** Build the card. `seed` rotates the tip deterministically (test seam). */
export function formatWelcomeCard(info: WelcomeInfo, seed = 0): WelcomeCard {
  const parts = [
    `v${info.version}`,
    info.provider && info.provider !== '' ? `${info.provider}/${info.model}` : info.model,
    info.branch ? `${info.cwd} (${info.branch})` : info.cwd,
  ];
  if (info.mcpCount > 0) parts.push(`${info.mcpCount} MCP`);
  const tips = TIPS.length;
  return {
    logo: NOVA_LOGO,
    meta: parts.filter((p) => p !== '').join(' · '),
    tip: TIPS[((seed % tips) + tips) % tips],
  };
}
