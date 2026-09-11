import * as fs from 'fs';
import * as path from 'path';
import type { Tool, ToolContext, ToolResult } from './types.js';

export function createWriteFileTool(): Tool {
  return {
    name: 'write_file',
    display: { kind: 'path' },
    description: 'Write content to a file. Supports overwrite and append modes.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to write' },
        content: { type: 'string', description: 'Content to write' },
        mode: { type: 'string', enum: ['overwrite', 'append'], description: 'Write mode (default: overwrite)' },
      },
      required: ['path', 'content'],
    },
    requiresPermission: () => true,
    async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const filePath = path.resolve(context.workingDirectory, params.path as string);
      const content = params.content as string;
      const mode = (params.mode as string) ?? 'overwrite';

      // Auto-create parent directories
      fs.mkdirSync(path.dirname(filePath), { recursive: true });

      if (mode === 'append') {
        fs.appendFileSync(filePath, content);
      } else {
        fs.writeFileSync(filePath, content);
      }

      return { content: `File written: ${filePath}` };
    },
  };
}
