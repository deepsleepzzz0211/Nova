import * as fs from 'fs';
import * as path from 'path';
import type { Tool, ToolContext, ToolResult } from './types.js';

const MAX_LINES = 1000;

export function createReadFileTool(): Tool {
  return {
    name: 'read_file',
    display: { kind: 'path' },
    permission: { mode: 'auto' },
    description: 'Read a file and return its contents with line numbers.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read' },
        offset: { type: 'number', description: 'Line number to start reading from (1-based)' },
        limit: { type: 'number', description: 'Maximum number of lines to read' },
      },
      required: ['path'],
    },
    async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const filePath = path.resolve(context.workingDirectory, params.path as string);

      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        return { content: `File not found: ${filePath}`, isError: true };
      }

      if (stat.isDirectory()) {
        return { content: `Path is a directory, not a file: ${filePath}`, isError: true };
      }

      // Binary detection: check first 8KB for null bytes
      const fd = fs.openSync(filePath, 'r');
      try {
        const probe = Buffer.alloc(Math.min(8192, stat.size));
        fs.readSync(fd, probe, 0, probe.length, 0);
        if (probe.includes(0)) {
          return { content: 'Cannot read binary file.', isError: true };
        }
      } finally {
        fs.closeSync(fd);
      }

      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      const offset = (params.offset as number) ?? 1;
      const limit = (params.limit as number) ?? MAX_LINES;
      const start = Math.max(0, offset - 1);
      const end = Math.min(lines.length, start + limit);
      const selected = lines.slice(start, end);

      const numbered = selected.map((line, i) => `${start + i + 1}\t${line}`);
      return { content: numbered.join('\n') };
    },
  };
}
