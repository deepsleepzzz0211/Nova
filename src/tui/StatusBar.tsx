import React from 'react';
import { Box, Text } from 'ink';

/** Props for the StatusBar component. */
export interface StatusBarProps {
  /** Name of the active LLM model. */
  model: string;
  /** Current working directory. */
  workingDirectory: string;
  /** Number of active MCP server connections. */
  mcpConnectionCount: number;
  /** One-line update notice (or null when silent). */
  updateNotice?: string;
  /** Prompt-cache metrics (pi-style R/W/CH). */
  cacheStats?: {
    hitRate: number;
    latestHitRate: number;
    totalCachedTokens: number;
    totalCacheWriteTokens: number;
  };
}

/** Format tokens as a compact human-readable number (e.g. 12.3k). */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Displays a status bar showing the current model, working directory,
 * number of active MCP connections, and prompt-cache usage (R/W/CH).
 */
export function StatusBar({ model, workingDirectory, mcpConnectionCount, cacheStats, updateNotice }: StatusBarProps): React.ReactElement {
  const mcpLabel = mcpConnectionCount === 1
    ? '1 MCP server'
    : `${mcpConnectionCount} MCP servers`;

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Text bold color="cyan">{model}</Text>
      <Text color="gray" dimColor>{workingDirectory}</Text>
      <Text color="gray" dimColor>{mcpLabel}</Text>
      {updateNotice && (
        <Text color="yellow">{updateNotice}</Text>
      )}
      {cacheStats && cacheStats.totalCachedTokens + cacheStats.totalCacheWriteTokens > 0 && (
        <Text color="green">
          {`R ${fmtTokens(cacheStats.totalCachedTokens)} W ${fmtTokens(cacheStats.totalCacheWriteTokens)} CH ${Math.round(cacheStats.latestHitRate * 100)}%`}
        </Text>
      )}
    </Box>
  );
}
