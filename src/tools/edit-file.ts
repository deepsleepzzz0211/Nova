import * as fs from 'fs';
import * as path from 'path';
import type { Tool, ToolContext, ToolResult } from './types.js';

export function createEditFileTool(): Tool {
  return {
    name: 'edit_file',
    display: { kind: 'path' },
    permission: { mode: 'auto' },
    description: 'Replace an exact string in a file. Errors if the string is not found or is ambiguous.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to edit' },
        old_string: { type: 'string', description: 'Exact string to find and replace' },
        new_string: { type: 'string', description: 'Replacement string' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const filePath = path.resolve(context.workingDirectory, params.path as string);
      const oldStr = params.old_string as string;
      const newStr = params.new_string as string;

      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        return { content: `File not found: ${filePath}`, isError: true };
      }

      const count = content.split(oldStr).length - 1;

      if (count === 0) {
        return { content: `old_string not found in ${filePath}`, isError: true };
      }

      if (count > 1) {
        return { content: `ambiguous match: old_string appears ${count} times in ${filePath}`, isError: true };
      }

      const updated = content.replace(oldStr, newStr);
      fs.writeFileSync(filePath, updated);

      return { content: `File edited: ${filePath}` };
    },
  };
}
