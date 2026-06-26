import type { Tool } from '../tools/types.js';

/** Metadata for an available skill. */
export interface SkillMeta {
  name: string;
  description: string;
  path: string;
}

/**
 * Build a system prompt that includes tool descriptions,
 * available skills, and an optional custom prompt section.
 */
export function buildSystemPrompt(
  tools: Tool[],
  skills: SkillMeta[],
  customPrompt?: string,
): string {
  const parts: string[] = [];

  // Base identity
  parts.push('You are Nova, a helpful AI assistant.');

  // Working directory
  parts.push(`Working directory: ${process.cwd()}`);

  // Tool descriptions
  if (tools.length > 0) {
    parts.push('');
    parts.push('## Available Tools');
    for (const tool of tools) {
      parts.push(`- **${tool.name}**: ${tool.description}`);
    }
  }

  // Available skills
  if (skills.length > 0) {
    parts.push('');
    parts.push('## Available Skills');
    for (const skill of skills) {
      parts.push(`- **${skill.name}**: ${skill.description}`);
    }
  }

  // Custom prompt
  if (customPrompt) {
    parts.push('');
    parts.push(customPrompt);
  }

  return parts.join('\n');
}
