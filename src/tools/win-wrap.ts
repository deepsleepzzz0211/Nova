import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SpawnInvocation } from './shell-routing.js';

/**
 * win32 realization of the tier-2 OS sandbox (batch-B ticket 02): shell
 * children are spawned through a tiny .NET wrapper that lowers the child's
 * integrity level to LOW — writes outside directories explicitly granted
 * to the Low mandatory label fail AT THE OS LAYER (EPERM), regardless of
 * how the command evaded the argv-level path policy. The grants (icacls,
 * Low-ML SID as DACL trustee) exist only while nova runs: state is
 * persisted and restored on exit — or first thing on the next start after
 * a hard crash. Everything here is injectable; production builds deps with
 * `defaultWinWrapDeps`.
 */

/** Low mandatory integrity label SID (S-1-16-4096). */
export const LOW_LABEL_SID = 'S-1-5-21-0-0-0-4096';

const CSC_RELATIVE = 'Microsoft.NET/Framework64/v4.0.30319/csc.exe';
const STATE_FILE = 'acl-state.json';
const EXE_NAME = 'nova-wrap.exe';

export interface WinWrapDeps {
  platform?: NodeJS.Platform;
  windir?: string;
  tempDir?: string;
  sandboxDir: string;
  existsFile(p: string): boolean;
  writeFile(p: string, data: string): void;
  removeFile(p: string): void;
  readFile(p: string): string | undefined;
  run(cmd: string, args: string[]): { code: number; stdout: string; stderr: string };
}

/** Production deps: real fs + synchronous process runs. */
export function defaultWinWrapDeps(novaHome: string): WinWrapDeps {
  const sandboxDir = path.join(novaHome, '.nova', 'sandbox');
  return {
    sandboxDir,
    existsFile: (p) => fs.existsSync(p),
    writeFile: (p, data) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, data);
    },
    removeFile: (p) => {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        // best effort
      }
    },
    readFile: (p) => {
      try {
        return fs.readFileSync(p, 'utf-8');
      } catch {
        return undefined;
      }
    },
    run: (cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: 'utf-8', windowsHide: true, timeout: 60_000 });
      return {
        code: r.status ?? 1,
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
      };
    },
  };
}

export interface WinWrapProbe {
  available: boolean;
  reason?: string;
}

/** Locate the preinstalled .NET Framework compiler (win10/11 ships it). */
export function findCsc(deps: WinWrapDeps): string | undefined {
  const windir = deps.windir ?? process.env.SystemRoot ?? 'C:\\Windows';
  const csc = path.join(windir, CSC_RELATIVE).replace(/\\/g, '/');
  return deps.existsFile(csc) || deps.existsFile(csc.replace(/\//g, '\\')) ? csc : undefined;
}

/** Cheap availability probe — no compilation, no side effects. */
export function probeWinWrap(deps: WinWrapDeps): WinWrapProbe {
  if ((deps.platform ?? process.platform) !== 'win32') {
    return { available: false, reason: 'landlock/seccomp enforcement is not implemented on this platform' };
  }
  const csc = findCsc(deps);
  if (csc === undefined) {
    return { available: false, reason: 'csc.exe (.NET Framework compiler) not found' };
  }
  return { available: true };
}

/** Compile-once-and-cache the low-integrity wrapper into the sandbox dir. */
export function ensureWrapper(deps: WinWrapDeps): { ok: true; exePath: string } | { ok: false; reason: string } {
  const exePath = path.join(deps.sandboxDir, EXE_NAME);
  if (deps.existsFile(exePath)) return { ok: true, exePath };
  const csc = findCsc(deps);
  if (csc === undefined) return { ok: false, reason: 'csc.exe (.NET Framework compiler) not found' };
  const csPath = path.join(deps.sandboxDir, 'nova-wrap.cs');
  deps.writeFile(csPath, WRAPPER_SOURCE);
  const res = deps.run(csc, ['-nologo', '-target:exe', `-out:${exePath}`, csPath]);
  if (res.code !== 0 || !deps.existsFile(exePath)) {
    return { ok: false, reason: `wrapper compile failed: ${(res.stderr || res.stdout).trim().slice(0, 200)}` };
  }
  return { ok: true, exePath };
}

/** Persist-and-grant: Low-ML DACL grants on the writable roots. */
export function grantRoots(deps: WinWrapDeps, roots: string[]): { ok: boolean; failed: string[] } {
  // A state file from a previous hard crash means stale grants are still
  // live — restore FIRST, then re-grant the requested set.
  restoreRoots(deps);
  const failed: string[] = [];
  for (const root of roots) {
    const res = deps.run('icacls', [root, '/grant', `*${LOW_LABEL_SID}:(OI)(CI)(M)`]);
    if (res.code !== 0) failed.push(root);
  }
  if (failed.length === 0) {
    deps.writeFile(path.join(deps.sandboxDir, STATE_FILE), JSON.stringify({ roots }));
    return { ok: true, failed: [] };
  }
  // Partial grant: roll back what we did apply so tier 1 is the ONLY regime.
  for (const root of roots) {
    if (!failed.includes(root)) deps.run('icacls', [root, '/remove', `*${LOW_LABEL_SID}`]);
  }
  return { ok: false, failed };
}

/** Remove every grant recorded in the state file (idempotent). */
export function restoreRoots(deps: WinWrapDeps): void {
  const statePath = path.join(deps.sandboxDir, STATE_FILE);
  const raw = deps.readFile(statePath);
  deps.removeFile(statePath);
  if (raw === undefined) return;
  let roots: string[] = [];
  try {
    const parsed = JSON.parse(raw) as { roots?: string[] };
    if (Array.isArray(parsed.roots)) roots = parsed.roots.filter((r): r is string => typeof r === 'string');
  } catch {
    roots = [];
  }
  for (const root of roots) deps.run('icacls', [root, '/remove', `*${LOW_LABEL_SID}`]);
}

/** MSVCRT command-line quoting (matches what CreateProcess reparses). */
export function quoteWinArg(arg: string): string {
  if (arg.length > 0 && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      slashes++;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(slashes * 2 + 1) + '"';
    } else {
      out += '\\'.repeat(slashes) + ch;
    }
    slashes = 0;
  }
  out += '\\'.repeat(slashes * 2);
  return out + '"';
}

/** Build the wrapper command line for one shell invocation. */
export function wrapInvocation(
  wrapperExe: string,
  invocation: SpawnInvocation,
  cwd: string,
): SpawnInvocation {
  const line = [invocation.file, ...invocation.args].map(quoteWinArg).join(' ');
  return {
    file: wrapperExe,
    args: ['--cwd', cwd, '--cmd', line],
    stdinText: invocation.stdinText,
  };
}

/**
 * The compiled-once wrapper: duplicates this process' primary token, sets
 * its mandatory label to LOW, and CreateProcessAsUserW's the requested
 * command line with inherited stdio (pipes included). Child exit code is
 * re-exited so spawn-runner semantics stay identical.
 */
export const WRAPPER_SOURCE = `
using System;
using System.Runtime.InteropServices;

class NovaWrap
{
    const uint TOKEN_QUERY = 0x0008, TOKEN_DUPLICATE = 0x0002,
               TOKEN_ASSIGN_PRIMARY = 0x0001, TOKEN_ADJUST_DEFAULT = 0x0080,
               TOKEN_ADJUST_SESSIONID = 0x0100;
    const uint MAXIMUM_ALLOWED = 0x02000000;
    const int TokenIntegrityLevel = 25;
    const int SecurityImpersonation = 2, TokenPrimary = 1;
    const uint STARTF_USESTDHANDLES = 0x00000100;

    [StructLayout(LayoutKind.Sequential)]
    struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }

    [StructLayout(LayoutKind.Sequential)]
    struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES Label; }

    [StructLayout(LayoutKind.Sequential)]
    struct SID_IDENTIFIER_AUTHORITY { public byte V0, V1, V2, V3, V4, V5; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow; public short cbReserved2;
        public IntPtr lpReserved2; public IntPtr hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll")] static extern void CloseHandle(IntPtr h);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool DuplicateTokenEx(IntPtr existing, uint access, IntPtr sa,
        int impersonation, int type, out IntPtr dup);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool SetTokenInformation(IntPtr token, int cls, ref TOKEN_MANDATORY_LABEL info, uint len);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessAsUserW(IntPtr token, string app, string cmd,
        IntPtr pa, IntPtr ma, bool inherit, uint flags, IntPtr env, string dir,
        ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool AllocateAndInitializeSid(SID_IDENTIFIER_AUTHORITY authz, byte subCount,
        uint a1, uint a2, uint a3, uint a4, uint a5, uint a6, uint a7, uint a8, ref IntPtr sid);
    [DllImport("advapi32.dll")] static extern void FreeSid(IntPtr sid);

    static int Main(string[] args)
    {
        string cwd = Environment.CurrentDirectory, cmd = null;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--cwd" && i + 1 < args.Length) { cwd = args[++i]; continue; }
            if (args[i] == "--cmd" && i + 1 < args.Length) { cmd = args[i + 1]; break; }
        }
        if (string.IsNullOrEmpty(cmd)) { Console.Error.WriteLine("nova-wrap: missing --cmd"); return 2; }
        if (cwd.IndexOf('/') >= 0) cwd = cwd.Replace('/', '\\\\');

        IntPtr stdIn = GetStdHandle(-10), stdOut = GetStdHandle(-11), stdErr = GetStdHandle(-12);
        SetHandleInformation(stdIn, 1, 1);
        SetHandleInformation(stdOut, 1, 1);
        SetHandleInformation(stdErr, 1, 1);

        IntPtr primary;
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_SESSIONID, out primary))
        { Console.Error.WriteLine("nova-wrap: OpenProcessToken err=" + Marshal.GetLastWin32Error()); return 3; }
        IntPtr dup;
        if (!DuplicateTokenEx(primary, MAXIMUM_ALLOWED, IntPtr.Zero, SecurityImpersonation, TokenPrimary, out dup))
        { Console.Error.WriteLine("nova-wrap: DuplicateTokenEx err=" + Marshal.GetLastWin32Error()); return 4; }

        var authz = new SID_IDENTIFIER_AUTHORITY { V0 = 0, V1 = 0, V2 = 0, V3 = 0, V4 = 0, V5 = 16 };
        IntPtr low = IntPtr.Zero;
        if (!AllocateAndInitializeSid(authz, 1, 0x00001000, 0, 0, 0, 0, 0, 0, 0, ref low))
        { Console.Error.WriteLine("nova-wrap: AllocateAndInitializeSid err=" + Marshal.GetLastWin32Error()); return 5; }

        var tml = new TOKEN_MANDATORY_LABEL();
        tml.Label.Sid = low;
        tml.Label.Attributes = 0x00000020; // SECURITY_MANDATORY_NO_EXECUTE_UP
        uint len = (uint)Marshal.SizeOf(typeof(TOKEN_MANDATORY_LABEL));
        if (!SetTokenInformation(dup, TokenIntegrityLevel, ref tml, len))
        { Console.Error.WriteLine("nova-wrap: SetTokenInformation err=" + Marshal.GetLastWin32Error()); return 6; }

        var si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.dwFlags = (int)STARTF_USESTDHANDLES;
        si.hStdInput = stdIn; si.hStdOutput = stdOut; si.hStdError = stdErr;
        PROCESS_INFORMATION pi;
        bool ok = CreateProcessAsUserW(dup, null, cmd, IntPtr.Zero, IntPtr.Zero, true, 0, IntPtr.Zero, cwd, ref si, out pi);
        FreeSid(low);
        if (!ok)
        { Console.Error.WriteLine("nova-wrap: CreateProcessAsUserW err=" + Marshal.GetLastWin32Error()); return 7; }

        WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
        uint code;
        GetExitCodeProcess(pi.hProcess, out code);
        CloseHandle(pi.hThread); CloseHandle(pi.hProcess); CloseHandle(dup); CloseHandle(primary);
        return (int)code;
    }
}
`;
