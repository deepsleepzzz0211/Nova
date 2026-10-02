/**
 * OS-level sandbox planning (batch-B ticket 02, G2 tier 2) — the pure
 * decision layer under the ticket-01 path policy. Policy tier 1 answers
 * "is this command allowed"; this layer answers "can we make the OS refuse
 * writes anyway" and, when it cannot, produces the visible fallback notice
 * instead of blocking the shell. The win32 realization (plan ③:
 * SetNamedSecurityInfoW via in-proc FFI, no new dependency) lives in
 * native-acl.ts; nothing here touches FFI so the decision stays testable.
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
  /** Additional writable roots beyond workspace+NOVA_HOME+temp (narrowing-only: appended, never replacing). */
  extraRoots?: string[];
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

/** Default writable roots, in audit order (ticket 01 allow-set + temp). */
export const DEFAULT_WRITABLE_ROOTS = ['workspace', 'novaHome', 'temp'] as const;

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
  const roots = [
    paths.workspaceRoot,
    paths.novaHome,
    paths.tempDir,
    ...(config.extraRoots ?? []),
  ];
  if (result.wrapperAvailable) {
    return {
      enabled: true,
      roots,
      notice: `OS-level sandbox enabled (win32 low-ACL): writes outside ${roots.length} roots fail at the OS layer.`,
    };
  }
  const reason = result.platform === 'win32'
    ? `${result.reason ?? 'no enforcement wrapper available'} — running tier-1 workspace path policy instead.`
    : POSIX_STUB;
  return { enabled: false, roots: [], notice: reason };
}

/**
 * Decide whether a shell spawn should be wrapped, and with which roots —
 * shared by bash and powershell. The one-time notice must surface exactly
 * once per process even when both tools consult this.
 */
let noticeShown = false;
export function osWrapDecision(
  plan: OsSandboxPlan,
): { wrap: boolean; roots: string[] } {
  return plan.enabled ? { wrap: true, roots: plan.roots } : { wrap: false, roots: [] };
}

/** Test seam + wiring use: consume the one-time notice text. */
export function takeNotice(plan: OsSandboxPlan): string | undefined {
  if (plan.notice === undefined || noticeShown) return undefined;
  noticeShown = true;
  return plan.notice;
}

/** Reset for tests (the module keeps process-lifetime one-shot semantics). */
export function resetNoticeForTests(): void {
  noticeShown = false;
}
