import type { LLMProvider } from '../llm/provider.js';
import type { Message, ToolCall } from '../llm/types.js';
import * as path from 'path';
import type { ToolResult } from '../tools/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolExecutionPipeline } from '../tools/execution-pipeline.js';
import type { SessionWriter } from './session.js';
import { Compactor } from './compaction.js';
import { ContextManager } from './context.js';
import { type DirectoryInstructions } from './directory-instructions.js';
import { type FileHistory, type WriteToolNames, type UndoReport } from './file-history.js';
import { resolveToolPath } from '../shared/tool-args.js';
import { StreamInterruptedError } from '../llm/stream-watchdog.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { BuildPromptOptions } from './prompt.js';
import { buildSystemPrompt } from './prompt.js';
import type { ThinkingLevel } from '../llm/types.js';

// Split-out regions of the loop (p1-p2 12). Names below stay re-exported so
// every historical import path (TUI, commands, tests) keeps resolving.
import { ContextOps } from './context-ops.js';
import { runTurn as runTurnImpl, type TurnHost } from './loop-turn.js';
import { executeToolCall as executeToolCallImpl, injectSkills as injectSkillsImpl } from './loop-tool-exec.js';
import type { AgentLoopConfig, AgentTurnResult, ContextDecisionReason, LoopContextConfig } from './loop-types.js';

export type { AgentLoopConfig, AgentTurnResult, ContextDecisionReason, LoopContextConfig } from './loop-types.js';

/**
 * Core orchestration loop that manages LLM conversation with tool execution.
 *
 * State + wiring live here; the turn engine lives in loop-turn.ts and the
 * context-management chain in context-ops.ts (p1-p2 12). Members marked
 * @internal are public ONLY so those sibling modules can drive the loop as
 * a TurnHost; they are not part of the supported API.
 */
export class AgentLoop implements TurnHost {
  /** @internal */ llm: LLMProvider;
  /** @internal */ readonly toolRegistry: ToolRegistry;
  private readonly toolExecutionPipeline: ToolExecutionPipeline;
  /** @internal */ readonly maxToolRounds: number;
  /** @internal */ model: string;
  private readonly contextManager: ContextManager | null;
  /** @internal */ readonly ctxOps: ContextOps;
  private readonly session: SessionWriter | null;
  private readonly skills: SkillRegistry | null;
  private readonly maxActiveSkills: number;
  /** @internal */ readonly directoryInstructions: DirectoryInstructions | null;
  /** @internal */ readonly fileHistory: FileHistory | null;
  private readonly promptOptions: BuildPromptOptions;
  private readonly onUsage: AgentLoopConfig['onUsage'];
  /** @internal */ readonly onContextSize: AgentLoopConfig['onContextSize'];
  /** @internal */ onThinking: AgentLoopConfig['onThinking'];
  /** @internal */ onToolCallReady: AgentLoopConfig['onToolCallReady'];
  /** @internal */ readonly thinkingLevel?: ThinkingLevel;
  /**
   * Base system prompt, frozen at construction.
   *
   * Cache philosophy (pi-style): the system prompt must stay byte-identical
   * across the whole session so the provider prompt-cache prefix survives.
   * Turn-scoped content (skills) travels as append-only messages instead.
   */
  /** @internal */ readonly frozenSystemPrompt: string;
  /** @internal */ readonly abortSignal?: AbortSignal;
  /** @internal */ readonly streamIdleTimeoutMs: number;
  /** Abort controller for the in-flight LLM stream (set per round). */
  /** @internal */ runAbort: AbortController | null = null;
  /** @internal */ onToken: (token: string) => void;
  /** @internal */ onToolCall: (call: ToolCall) => void;
  /** @internal */ onToolResult: (result: ToolResult, callId?: string) => void;
  private readonly onPermissionRequest: (call: ToolCall) => Promise<boolean>;
  private messages: Message[] = [];

  constructor(options: AgentLoopConfig) {
    this.llm = options.llm;
    this.toolRegistry = options.toolRegistry;
    this.toolExecutionPipeline = options.toolExecutionPipeline;
    this.maxToolRounds = options.config.maxToolRounds;
    this.model = options.config.model;
    this.contextManager = options.context
      ? new ContextManager({
          model: options.config.model,
          maxTokens: options.context.maxTokens,
          reserveTokens: options.context.reserveTokens,
        })
      : null;
    const compactor = options.context?.strategy === 'compact' && options.context
      ? new Compactor(options.llm, options.config.model, {
          keepRecentTokens: options.context.keepRecentTokens,
          triggerTokens: this.contextManager?.triggerTokens,
          // G19: summary requests ride the main chain's cached prefix.
          getMainPrefix: () => ({
            systemPrompt: this.frozenSystemPrompt,
            tools: this.toolRegistry.toToolDefinitions(),
          }),
        })
      : null;
    this.session = options.session ?? null;
    this.fileHistory = options.fileHistory ?? null;
    this.ctxOps = new ContextOps({
      getMessages: () => this.messages,
      setMessages: (messages: Message[]) => { this.messages = messages; },
      contextManager: this.contextManager,
      contextStrategy: options.context?.strategy ?? null,
      compactor,
      fileHistory: this.fileHistory,
      fileWriteTools: () => this.fileWritingToolNames(),
      microcompactIdleMs: options.context?.microcompactIdleMs ?? 60 * 60 * 1000,
      session: this.session,
      onCompaction: options.onCompaction,
      onContextNote: options.onContextNote,
    });
    this.skills = options.skills ?? null;
    this.maxActiveSkills = options.maxActiveSkills ?? 2;
    this.directoryInstructions = options.directoryInstructions ?? null;
    this.promptOptions = options.promptOptions ?? {};
    this.onUsage = options.onUsage;
    this.onContextSize = options.onContextSize;
    this.onThinking = options.onThinking;
    this.onToolCallReady = options.onToolCallReady;
    this.thinkingLevel = options.thinkingLevel;
    this.abortSignal = options.abortSignal;
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? 60_000;
    this.frozenSystemPrompt = buildSystemPrompt(this.toolRegistry.getAll(), options.skills?.findAll() ?? [], {
      ...this.promptOptions,
      countText: this.contextManager ? (t: string) => this.contextManager!.countText(t) : undefined,
    });
    this.onToken = options.onToken;
    this.onToolCall = options.onToolCall;
    this.onToolResult = options.onToolResult;
    this.onPermissionRequest = options.onPermissionRequest;
  }

  /** Seed the conversation from a previous session (resume). */
  loadMessages(history: Message[]): void {
    this.messages = [...history];
  }

  /** Switch the active model (per-request ChatOptions value). */
  setModel(model: string): void {
    this.model = model;
  }

  /** Switch the LLM provider (e.g. after a catalog-driven /model switch). */
  setProvider(llm: LLMProvider): void {
    this.llm = llm;
  }

  /** @internal The live conversation array handed to provider requests. */
  get currentMessages(): Message[] {
    return this.messages;
  }

  /** Append a message to the conversation and the session log. */
  /** @internal */ pushMessage(message: Message): void {
    this.messages.push(message);
    void this.session?.append(message);
  }

  /**
   * Undo the last N conversation turns (a turn = one user message and
   * everything after it until the next user message). By default
   * conversation-only. With `{ withFiles }` the files the undone turns
   * touched are restored to their pre-turn snapshots (externally-changed
   * files are skipped). Persistence stays append-only: the post-undo state
   * is written as a checkpoint, which --resume replays as the truncated
   * history. N is clamped to the number of available turns.
   */
  undoTurns(n = 1, opts?: { withFiles?: boolean }): {
    undone: boolean;
    undoneTurns: number;
    files?: UndoReport;
  } {
    return this.ctxOps.undoTurns(n, opts);
  }

  /** Write-tool files restorable when undoing the last n turns (/undo ask). */
  touchedFilesInUndoWindow(n: number): string[] {
    return this.ctxOps.touchedFilesInUndoWindow(n);
  }

  /**
   * Force a compaction/truncation pass regardless of the token trigger.
   * Origins: the /compact command ('manual') and reactive overflow recovery
   * ('overflow') — both bypass the automatic-path gates.
   */
  async compactNow(origin: 'manual' | 'overflow' = 'manual'): Promise<{
    compacted: boolean;
    strategy?: 'truncate' | 'compact';
    beforeTokens?: number;
    afterTokens?: number;
  }> {
    return this.ctxOps.compactNow(origin);
  }

  async processUserInput(input: string): Promise<AgentTurnResult> {
    return runTurnImpl(this, input);
  }

  /**
   * Interrupt the in-flight LLM stream (streaming ticket 02). Partial text
   * already received is kept as the assistant message; incomplete tool-call
   * half-frames are discarded (their argument JSON may be truncated and
   * executing them would be a hazard).
   */
  interrupt(): void {
    this.runAbort?.abort(new StreamInterruptedError());
  }

  /** Report the real context size to the UI (ticket 22). */
  private emitContextSize(): void {
    if (!this.contextManager || this.onContextSize === undefined) return;
    this.onContextSize(
      this.contextManager.countTokens(this.messages),
      this.contextManager.triggerTokens,
    );
  }

  /** Report aggregated per-turn usage to the cache metrics listener. */
  /** @internal */ emitUsage(usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
  }): void {
    // Report the context size BEFORE the zero-usage guard: providers may not
    // report usage at all, and a stale footer gauge would be misleading.
    this.emitContextSize();
    if (usage.inputTokens === 0 && usage.outputTokens === 0) return;
    this.onUsage?.({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
    });
  }

  /**
   * Load full bodies of skills matching the user input as an append-only
   * system message. The frozen system prompt itself is never mutated, so
   * the provider prompt-cache prefix stays valid.
   */
  /** @internal */ async injectSkills(userInput: string): Promise<void> {
    return injectSkillsImpl(this.skills, this.maxActiveSkills, userInput, (message) => this.pushMessage(message));
  }

  /**
   * Inject not-yet-seen directory instructions for the file a successful
   * read/edit/write call touched. Append-only system messages, same cache
   * discipline as skills.
   */
  /** @internal */ injectDirectoryInstructions(call: ToolCall, result: ToolResult): void {
    if (this.directoryInstructions === null) return;
    if (result.isError) return;
    if (!this.fileTouchingToolNames().has(call.function.name)) return;
    const filePath = resolveToolPath(call.function.arguments);
    if (filePath === null) return;
    for (const pending of this.directoryInstructions.pendingFor(filePath)) {
      const rel = path.relative(process.cwd(), pending.file) || pending.file;
      this.pushMessage({
        role: 'system',
        content: `[Directory instructions — ${rel}]\n${pending.content}`,
      });
    }
  }

  /** Registry-derived: tools declaring any file access (read or write). */
  /** @internal */ fileTouchingToolNames(): ReadonlySet<string> {
    return new Set(
      this.toolRegistry.getAll().filter((t) => t.fileAccess !== undefined).map((t) => t.name),
    );
  }

  /**
   * Registry-derived: tools whose calls WRITE files (checkpointed/undoable).
   * Falls back to the canonical write set when the registry has no
   * fileAccess-declared tools (bare test registries) — the fallback names
   * are the very tools shipped in src/tools, never arbitrary extensions.
   */
  /** @internal */ fileWritingToolNames(): WriteToolNames {
    const declared = this.toolRegistry
      .getAll()
      .filter((t) => t.fileAccess === 'write')
      .map((t) => t.name);
    return new Set(declared.length > 0 ? declared : ['edit_file', 'write_file']);
  }

  /**
   * Execute one tool call through the pipeline and notify the UI. Write
   * tools additionally take the pre-change snapshot (ticket 03): capture
   * BEFORE the call, mark written only on success.
   */
  /** @internal */ async executeToolCall(call: ToolCall): Promise<ToolResult> {
    let snapshotTarget: string | null = null;
    if (this.fileHistory !== null && this.fileWritingToolNames().has(call.function.name)) {
      snapshotTarget = resolveToolPath(call.function.arguments);
      if (snapshotTarget !== null) {
        this.fileHistory.snapshotBefore(snapshotTarget);
      }
    }
    const result = await executeToolCallImpl(
      {
        toolRegistry: this.toolRegistry,
        toolExecutionPipeline: this.toolExecutionPipeline,
        abortSignal: this.abortSignal,
        onToolResult: this.onToolResult,
        onPermissionRequest: this.onPermissionRequest,
      },
      call,
    );
    if (snapshotTarget !== null && !result.isError) {
      this.fileHistory?.noteWritten(snapshotTarget);
    }
    return result;
  }

  /** Current conversation history (introspection/testing). */
  getMessages(): readonly Message[] {
    return this.messages;
  }
}
