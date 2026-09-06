import type { Tool } from '../tools/types.js';
import type { PromptEnvironment } from './environment.js';

/** Metadata for an available skill (one-line listing only). */
export interface SkillMeta {
  name: string;
  description: string;
  path: string;
}

/** Options for building the system prompt. */
export interface BuildPromptOptions {
  /** Runtime environment facts (cwd, platform, git). */
  environment?: PromptEnvironment;
  /** Project-level instructions (AGENTS.md / CLAUDE.md content). */
  projectInstructions?: string;
  /** Extra prompt section from config (agent.systemPrompt). */
  customPrompt?: string;
}

/**
 * Build the system prompt:
 * identity → environment → project instructions → tools → skills → custom.
 */
export function buildSystemPrompt(
  tools: Tool[],
  skills: SkillMeta[],
  options?: BuildPromptOptions,
): string {
  const parts: string[] = [];

  // Identity
  parts.push(
    'You are Nova, an expert coding agent that helps with software engineering tasks.',
    'You can read and edit files, run shell commands, search the web, and call MCP tools.',
    'Work methodically: understand the request, inspect relevant files, make careful changes, and verify results.',
    'Use the todo_write tool to track multi-step work and keep the user informed.',
  );

  // Environment
  if (options?.environment) {
    const env = options.environment;
    parts.push('', '## Environment');
    parts.push(`Working directory: ${env.workingDirectory}`);
    parts.push(`Platform: ${env.platform}`);
    if (env.gitBranch) {
      parts.push(`Git branch: ${env.gitBranch}`);
    }
    if (env.gitStatus) {
      parts.push(`Git status:\n${env.gitStatus}`);
    }
  }

  // Project instructions
  if (options?.projectInstructions) {
    parts.push('', '## Project Instructions', options.projectInstructions);
  }

  // Tool descriptions
  if (tools.length > 0) {
    parts.push('', '## Available Tools');
    for (const tool of tools) {
      parts.push(`- **${tool.name}**: ${tool.description}`);
    }
  }

  // Skills (one-line listings; full bodies are injected on demand)
  if (skills.length > 0) {
    parts.push('', '## Available Skills');
    for (const skill of skills) {
      parts.push(`- **${skill.name}**: ${skill.description}`);
    }
  }

  // Custom prompt
  if (options?.customPrompt) {
    parts.push('', options.customPrompt);
  }

  return parts.join('\n');
}
