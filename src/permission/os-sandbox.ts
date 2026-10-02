/**
 * OS-level sandbox planning (batch-B ticket 02, G2 tier 2) — the pure
 * decision layer under the ticket-01 path policy. Policy tier 1 answers
 * "is this command allowed"; this layer answers "can we make the OS refuse
 * writes anyway" and, when it cannot, produces the visible fallback notice
 * instead of blocking the shell. The win32 realization (low-IL wrapper +
 * icacls grants + per-binary smoke gate) lives in tools/win-wrap.ts and
 * tools/win-smoke.ts; nothing here touches processes so the decision stays
 * testable.
 */

/** What the platform probe found (injected; never throws). */
export interface OsSandboxProbeResult {
  platform: NodeJS.Platform;
  /** True when a working OS-level enforcement path exists on this machine. */
  wrapperAvailable: boolean;
  /** Why it is unavailable (probe failure detail, stub wording, …). */
  reason?: string;
}

export type OsSandboxProbe = () => OsSandboxProbeResult;

export interface OsSandboxConfig {
  /** 'off' (default) | 'auto' (enable when the probe finds enforcement). */
  osLevel: 'off' | 'auto';
}

export interface OsSandboxPaths {
  workspaceRoot: string;
  novaHome: string;
  tempDir: string;
}

export interface OsSandboxPlan {
  /** True = wrap child processes with OS enforcement. */
  enabled: boolean;
  /** Directories writable at the OS level when enabled. */
  roots: string[];
  /** User-facing fallback/enforcement note (stderr at wiring time). */
  notice?: string;
}

/** Writable roots, in audit order (ticket 01 allow-set + temp). */
export const DEFAULT_WRITABLE_ROOTS = ['workspaceRoot', 'novaHome', 'tempDir'] as const;

const POSIX_STUB =
  'OS-level sandbox: landlock exists on this kernel surface but is not implemented in this build — running tier-1 workspace path policy instead.';

/** Resolve the config into an enable/fallback decision. Never throws. */
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

/** Test seam + wiring use: consume the one-time notice text. */
let noticeShown = false;
export function takeNotice(plan: OsSandboxPlan): string | undefined {
  if (plan.notice === undefined || noticeShown) return undefined;
  noticeShown = true;
  return plan.notice;
}

/** Reset for tests (the module keeps process-lifetime one-shot semantics). */
export function resetNoticeForTests(): void {
  noticeShown = false;
}
