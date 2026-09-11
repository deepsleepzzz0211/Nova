/**
 * Startup header (tui-refactor ticket 10): printed once before the TUI takes
 * over, so it lands in the terminal scrollback and costs nothing afterwards.
 * Pure formatting — the caller supplies what was actually loaded.
 */
export interface StartupHeaderInfo {
  version: string;
  model: string;
  provider?: string;
  thinkingLevel?: string;
  /** Context files that were loaded (AGENTS.md, MEMORY.md, …). */
  contextFiles: string[];
  /** Loaded skills. */
  skillNames: string[];
  /** Configured MCP servers (names only). */
  mcpServers: string[];
  /** Working directory. */
  cwd: string;
}

/** Key bindings actually implemented by the editor/modal handlers. */
const HOTKEYS = [
  'esc interrupt',
  'ctrl+o tools',
  'ctrl+c clear/exit',
  'shift+enter newline',
  '@ file completion',
  '/ commands',
].join(' · ');

/** Render the header as plain lines (no ANSI) for scrollback. */
export function formatStartupHeader(info: StartupHeaderInfo): string {
  const lines: string[] = [];

  const identity = [info.provider ? `${info.provider}/${info.model}` : info.model, info.thinkingLevel ? `thinking ${info.thinkingLevel}` : null]
    .filter((part): part is string => part !== null && part !== '')
    .join(' · ');
  lines.push(`nova ${info.version}${identity ? ` · ${identity}` : ''}`);
  lines.push(HOTKEYS);
  lines.push(`cwd ${info.cwd}`);

  if (info.contextFiles.length > 0) {
    lines.push(`context: ${info.contextFiles.join(', ')}`);
  }
  if (info.skillNames.length > 0) {
    lines.push(`skills (${info.skillNames.length}): ${info.skillNames.join(', ')}`);
  }
  if (info.mcpServers.length > 0) {
    lines.push(`mcp: ${info.mcpServers.join(', ')}`);
  }

  return lines.join('\n');
}
