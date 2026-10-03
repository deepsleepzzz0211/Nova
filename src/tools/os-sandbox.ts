import {
  ensureWrapper,
  grantRoots,
  probeWinWrap,
  restoreRoots,
  wrapInvocation,
  type WinWrapDeps,
} from './win-wrap.js';
import { createShellGate } from './win-smoke.js';
import type { SpawnInvocation } from './shell-routing.js';

/**
 * OS-level sandbox (batch-B ticket 02, G2 tier 2; arch ticket 01 deepening):
 * ONE module owning the whole lifecycle — probe, wrapper compile, icacls
 * grants, per-binary smoke gate, notices, and exit restore. Lives in the
 * tools layer, not permission: the facade performs IO (csc/icacls/spawn),
 * and the arch ratchet (correctly) forbids permission -> tools. The caller
 * learns four members; the step ORDERING (prep up front so child timeouts
 * never spend setup budget; notice only after grants land; restore-first
 * against crash leftovers; rollback on partial grant) is invariant, not
 * caller knowledge. POSIX has no enforcement in this build: 'auto' degrades
 * to tier 1 with the stub notice.
 */

export interface OsSandboxPaths {
  workspaceRoot: string;
  /** The granted `~/.nova` subtree (NOT the wrapper cache dir — deps own that). */
  novaHome: string;
  tempDir: string;
}

export interface OsSandboxOptions {
  /** 'off' (default) | 'auto' (enable when the machine actually can). */
  osLevel: 'off' | 'auto';
  paths: OsSandboxPaths;
  /** Realization adapter (fs + process runs); production = defaultWinWrapDeps(novaHome()). */
  deps: WinWrapDeps;
}

export interface OsSandbox {
  /** True only when grants landed; wrapSpawn is meaningful only then. */
  readonly enabled: boolean;
  /** Notices accumulated since the last drain, in order; each surfaces once. */
  drainNotices(): string[];
  /** Identity for ineligible binaries and disabled sandboxes. */
  wrapSpawn(invocation: SpawnInvocation, cwd: string): SpawnInvocation;
  /** Remove live grants + clear state; idempotent, safe when disabled. */
  dispose(): void;
}

/** Result of the pure decision layer (internal seam; also unit-tested). */
export interface OsSandboxPlan {
  enabled: boolean;
  roots: string[];
  notice?: string;
}

/** What the platform probe found (injected; never throws). */
export interface OsSandboxProbeResult {
  platform: NodeJS.Platform;
  wrapperAvailable: boolean;
  reason?: string;
}

export type OsSandboxProbe = () => OsSandboxProbeResult;

export interface OsSandboxConfig {
  osLevel: 'off' | 'auto';
}

/** Writable roots, in audit order (ticket 01 allow-set + temp). */
export const DEFAULT_WRITABLE_ROOTS = ['workspaceRoot', 'novaHome', 'tempDir'] as const;

const POSIX_STUB =
  'OS-level sandbox: landlock exists on this kernel surface but is not implemented in this build — running tier-1 workspace path policy instead.';

/** Pure enable/fallback decision. Never throws. */
export function planOsSandbox(
  config: OsSandboxConfig,
  paths: OsSandboxPaths,
  probe: OsSandboxProbe,
): OsSandboxPlan {
  if (config.osLevel !== 'auto') {
    return { enabled: false, roots: [] };
  }
  let result: OsSandboxProbeResult;
  try {
    result = probe();
  } catch (err) {
    result = {
      platform: process.platform,
      wrapperAvailable: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  if (result.wrapperAvailable) {
    const roots = DEFAULT_WRITABLE_ROOTS.map((field) => paths[field]);
    return {
      enabled: true,
      roots,
      notice: `OS-level sandbox (win32 low-ACL): grants active on ${roots.length} roots; each shell is probed before wrapping and degrades visibly to tier-1 if it fails.`,
    };
  }
  const reason = result.platform === 'win32'
    ? `${result.reason ?? 'no enforcement wrapper available'} — running tier-1 workspace path policy instead.`
    : POSIX_STUB;
  return { enabled: false, roots: [], notice: reason };
}

function baseName(file: string): string {
  const parts = file.split(/[/\\]/);
  return parts[parts.length - 1] ?? file;
}

function disabled(notices: string[]): OsSandbox {
  return {
    enabled: false,
    drainNotices: () => {
      const out = notices.slice();
      notices.length = 0;
      return out;
    },
    wrapSpawn: (inv) => inv,
    dispose: () => {},
  };
}

/**
 * Run the full lifecycle and return the deep module. All side effects
 * (compile/grant) happen synchronously HERE — never inside a tool call —
 * so a child-process timeout can never be spent on setup.
 */
export function createOsSandbox(options: OsSandboxOptions): OsSandbox {
  if (options.osLevel !== 'auto') {
    return disabled([]);
  }
  const deps = options.deps;
  const notices: string[] = [];

  const plan = planOsSandbox(
    { osLevel: 'auto' },
    options.paths,
    () => {
      const p = probeWinWrap(deps);
      return {
        platform: deps.platform ?? process.platform,
        wrapperAvailable: p.available,
        reason: p.reason,
      };
    },
  );
  if (!plan.enabled) {
    if (plan.notice !== undefined) notices.push(plan.notice);
    return disabled(notices);
  }

  const w = ensureWrapper(deps);
  if (!w.ok) {
    notices.push(`tier-2 could not activate (${w.reason}) — continuing with tier-1 path policy only`);
    return disabled(notices);
  }
  const g = grantRoots(deps, plan.roots);
  if (!g.ok) {
    restoreRoots(deps);
    notices.push(
      `tier-2 could not activate (grant failed on: ${g.failed.join(', ')}) — continuing with tier-1 path policy only`,
    );
    return disabled(notices);
  }
  // The success claim is only spoken after the grants actually landed.
  notices.push(`OS-level sandbox (win32 low-ACL): grants active on ${plan.roots.length} roots; each shell is probed before wrapping and degrades visibly to tier-1 if it fails.`);

  const gate = createShellGate(deps, w.exePath, plan.roots[0] ?? options.paths.workspaceRoot, (file, detail) => {
    notices.push(`tier-2 not wrapping ${baseName(file)} (${detail}) — that shell stays on tier-1 path policy`);
  });

  let drained = 0;
  let disposed = false;
  return {
    enabled: true,
    drainNotices() {
      const out = notices.slice(drained);
      drained = notices.length;
      return out;
    },
    wrapSpawn(invocation, cwd) {
      if (!gate(invocation.file)) return invocation;
      return wrapInvocation(w.exePath, invocation, cwd);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      restoreRoots(deps);
    },
  };
}
