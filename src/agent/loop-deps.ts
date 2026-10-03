import { novaHome } from '../config/loader.js';
import type { AppConfig } from '../config/schema.js';
import type { ResolvedModel } from '../llm/catalog.js';
import type { ThinkingLevel } from '../llm/types.js';
import type { BuildPromptOptions } from './prompt.js';
import type { LoopContextConfig } from './loop-types.js';
import { DirectoryInstructions } from './directory-instructions.js';
import { FileHistory, fileHistoryDir } from './file-history.js';

/**
 * Shared AgentLoop assembly (arch ticket 04): the wiring that print mode and
 * the TUI hook used to duplicate — context options from config+resolution,
 * the NOVA_HOME-rooted checkpoint dir keyed by session id, prompt parts,
 * and the loop's scalar knobs. Callbacks stay with each caller (they are
 * genuinely different: sinks vs TUI state); this is the common core, so the
 * ordering knowledge (session id -> historyDir) lives in exactly one place.
 */

export interface LoopBaseInput {
  config: AppConfig;
  resolution: ResolvedModel;
  /** Session id keys the checkpoint tree; must be the live session's id. */
  sessionId: string;
  /** Prompt parts (TUI and print mode pass the same runtime facts). */
  environment?: BuildPromptOptions['environment'];
  projectInstructions?: BuildPromptOptions['projectInstructions'];
  memory?: BuildPromptOptions['memory'];
  customPrompt?: string;
  /** Root for lazy AGENTS.md collection; default process.cwd(). */
  rootDir?: string;
}

export interface LoopBase {
  promptOptions: BuildPromptOptions;
  context: LoopContextConfig;
  directoryInstructions: DirectoryInstructions;
  fileHistory: FileHistory;
  streamIdleTimeoutMs?: number;
  thinkingLevel: ThinkingLevel;
  config: { maxToolRounds: number; model: string };
}

export function buildLoopBase(input: LoopBaseInput): LoopBase {
  const { config, resolution } = input;
  return {
    promptOptions: {
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
      ...(input.projectInstructions !== undefined ? { projectInstructions: input.projectInstructions } : {}),
      ...(input.memory !== undefined ? { memory: input.memory } : {}),
      customPrompt: input.customPrompt,
      skillsBudgetTokens: config.agent.skillsBudgetTokens,
    },
    context: {
      maxTokens: resolution.model.contextWindow,
      reserveTokens: config.agent.contextReserveTokens,
      keepRecentTokens: config.agent.contextKeepRecentTokens,
      strategy: config.agent.contextStrategy as 'truncate' | 'compact',
    },
    directoryInstructions: new DirectoryInstructions({
      rootDir: input.rootDir ?? process.cwd(),
    }),
    // Checkpoints key on the session id; an --resume'd session finds its
    // files under the same tree (ticket 03 discipline).
    fileHistory: new FileHistory({
      historyDir: fileHistoryDir(novaHome(), input.sessionId),
    }),
    streamIdleTimeoutMs: config.llm.streamIdleTimeoutMs,
    thinkingLevel: config.agent.thinkingLevel as ThinkingLevel,
    config: { maxToolRounds: config.agent.maxToolRounds, model: config.llm.model },
  };
}
