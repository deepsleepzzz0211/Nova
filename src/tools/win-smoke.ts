import * as path from 'node:path';
import type { WinWrapDeps } from './win-wrap.js';

/**
 * Smoke probe + per-binary wrap eligibility for the tier-2 win32
 * low-integrity sandbox (batch-B ticket 02, split from win-wrap.ts under
 * the file-size ratchet). The wrap is only trustworthy if a REAL child,
 * started through it, can both boot and write the granted roots; shells
 * that fail run unwrapped under tier-1, visibly.
 */

export type ShellGate = (file: string) => boolean;

/**
 * Per-binary wrap eligibility: some shells (msys2/Git Bash) refuse to
 * start under Low integrity outright, so each shell family is probed once
 * through the wrapper and only wrapping shells get wrapped; the rest fall
 * back to the tier-1 policy for that invocation. Memoized: one probe per
 * binary per process.
 */
export function createShellGate(
  deps: WinWrapDeps,
  wrapperExe: string,
  writeRoot: string,
  onDegrade?: (file: string, detail: string) => void,
): ShellGate {
  const memo = new Map<string, boolean>();
  return (file) => {
    const hit = memo.get(file);
    if (hit !== undefined) return hit;
    const probe = smokeProbe(deps, wrapperExe, file, writeRoot);
    if (!probe.ok) onDegrade?.(file, probe.detail ?? 'smoke probe failed');
    memo.set(file, probe.ok);
    return probe.ok;
  };
}

/** Result of the startup smoke probe. */
export interface SmokeResult {
  ok: boolean;
  detail?: string;
}

/**
 * Reality check before trusting the wrap, in TWO parts inside one wrapped
 * shell: (1) it must start (echo) — msys2/Git Bash aborts at Low integrity
 * (NtCreateDirectoryObject on the named-object namespace is refused by the
 * mandatory policy); (2) it must actually WRITE into a granted root — a
 * DACL grant alone is not enough when the root's integrity label refuses
 * Low writers (NO_WRITE_UP; relabeling needs elevation). A half-working
 * sandbox that green-lights itself while blocking legitimate writes is
 * worse than none, so both parts must pass.
 */
export function smokeProbe(
  deps: WinWrapDeps,
  wrapperExe: string,
  file: string,
  writeRoot: string,
): SmokeResult {
  const isCmd = /cmd\.exe$/i.test(file);
  // ';' not '&&': PowerShell 5.1 has no && operator, and ';' works in
  // bash too. cmd keeps && (it has no ; separator).
  const flag = isCmd ? '/c' : '-c';
  const sep = isCmd ? ' && ' : '; ';
  const root = writeRoot.replace(/\\/g, '/');
  // The write attempt lives in a materialized script: quoting an inline
  // node -e through wrapper -> CreateProcess -> shell -> node is
  // unresolvable across cmd/bash/powershell, so the command line stays
  // quote-free. A failed probe degrades (safe direction).
  const probePath = path.join(deps.sandboxDir, 't2-probe.js').replace(/\\/g, '/');
  deps.writeFile(
    probePath,
    "try{const f=require('fs');f.writeFileSync('" +
      root +
      "/.nova-t2-probe','p');f.unlinkSync('" +
      root +
      "/.nova-t2-probe');console.log('nova-t2-write')}catch(e){console.log('WRITE-DENIED-'+e.code)}",
  );
  const res = deps.run(wrapperExe, [
    '--cwd',
    deps.tempDir ?? deps.sandboxDir,
    '--cmd',
    `${file} ${flag} "echo nova-t2-smoke${sep}node ${probePath}"`,
  ]);
  const started = res.stdout.includes('nova-t2-smoke');
  if (res.code === 0 && started && res.stdout.includes('nova-t2-write')) {
    return { ok: true };
  }
  // Started but no write marker (or an explicit WRITE-DENIED code): the
  // granted root is not writable at Low — ML wall, not a transient.
  if (started || /WRITE-DENIED/.test(res.stdout + res.stderr)) {
    return { ok: false, detail: 'wrapped child started but cannot write granted roots (integrity label)' };
  }
  const detail = (res.stderr || res.stdout).trim().slice(0, 200);
  return { ok: false, detail: detail === '' ? `exit code ${res.code}` : detail };
}
