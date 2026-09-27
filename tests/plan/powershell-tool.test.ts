import { describe, it, expect } from 'vitest';
import {
  resolvePowerShell,
  buildPowerShellInvocation,
  createPowerShellTool,
  shouldRegisterPowerShell,
} from '../../src/tools/powershell.js';
import { defaultShellProbe, type ShellProbe } from '../../src/tools/shell-routing.js';
import { DANGEROUS_PATTERNS } from '../../src/permission/dangerous.js';

function probe(which: Record<string, string | null>): ShellProbe {
  return { exists: () => false, which: (exe) => which[exe] ?? null };
}

function flagReason(command: string): string | null {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) return reason;
  }
  return null;
}

describe('powershell resolution (Pi semantics)', () => {
  it('prefers pwsh.exe (PowerShell 7) over powershell.exe', () => {
    const p = resolvePowerShell(probe({
      'pwsh.exe': 'C:\\Program Files\\WindowsPowerShell\\pwsh.exe',
      'powershell.exe': 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    }));
    expect(p?.path).toContain('pwsh.exe');
    expect(p?.flavor).toBe('pwsh');
  });
  it('falls back to Windows PowerShell 5.1', () => {
    const p = resolvePowerShell(probe({ 'pwsh.exe': null, 'powershell.exe': 'C:\\ps.exe' }));
    expect(p?.path).toBe('C:\\ps.exe');
    expect(p?.flavor).toBe('windowspowershell');
  });
  it('null when neither exists', () => {
    expect(resolvePowerShell(probe({}))).toBeNull();
  });
});

describe('buildPowerShellInvocation', () => {
  it('pins the hardening flags and -Command shape', () => {
    const inv = buildPowerShellInvocation({ path: 'pwsh.exe', flavor: 'pwsh' }, 'Get-ChildItem');
    expect(inv.file).toBe('pwsh.exe');
    expect(inv.args.slice(0, 4)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
    expect(inv.args[4]).toBe('-Command');
    expect(inv.args[5]).toContain('Get-ChildItem');
  });
  it('prefixes the UTF-8 output preamble (Chinese output must not mojibake)', () => {
    const inv = buildPowerShellInvocation({ path: 'ps.exe', flavor: 'windowspowershell' }, 'Write-Output "中文"');
    expect(inv.args[5]).toMatch(/\[Console\]::OutputEncoding.*UTF8/);
    expect(inv.args[5].indexOf('Write-Output')).toBeGreaterThan(0);
  });
});

describe('powershell tool contract', () => {
  it('ask-permission, command display, named powershell', () => {
    const tool = createPowerShellTool();
    expect(tool.name).toBe('powershell');
    expect(tool.permission?.mode).toBe('ask');
    expect(tool.display).toEqual({ kind: 'command' });
    expect(tool.metadata?.cacheable).toBe(false);
  });
  it('approval preview echoes the command (narrow-only)', async () => {
    const tool = createPowerShellTool();
    const note = await tool.prepareApproval?.(
      { command: 'Get-Service' },
      { workingDirectory: '.', abortSignal: new AbortController().signal },
    );
    expect(note).toBeDefined();
    expect(note?.previewNote).toContain('Get-Service');
    expect(note?.block).toBeUndefined();
  });
  it('missing interpreter is a clean tool error', async () => {
    const tool = createPowerShellTool({ probe: probe({}) });
    const r = await tool.execute({ command: 'Get-Date' }, { workingDirectory: '.', abortSignal: new AbortController().signal });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/PowerShell/i);
  });
  it('registration gate: win32 only', () => {
    expect(shouldRegisterPowerShell('win32')).toBe(true);
    expect(shouldRegisterPowerShell('linux')).toBe(false);
    expect(shouldRegisterPowerShell('darwin')).toBe(false);
  });
});

// Real spawn pass on the Windows leg (CI + this machine): powershell.exe
// always exists there, so the full resolve->spawn->UTF-8 roundtrip is pinned.
const realSpawn = process.platform === 'win32' ? it : it.skip;
realSpawn('powershell tool executes a real command with Chinese output intact', async () => {
  const shell = resolvePowerShell(defaultShellProbe);
  expect(shell).not.toBeNull();
  const r = await createPowerShellTool().execute(
    { command: 'Write-Output "ps-works"; Write-Output "中文OK"' },
    { workingDirectory: '.', abortSignal: new AbortController().signal },
  );
  expect(r.isError).toBeUndefined();
  expect(r.metadata?.exitCode).toBe(0);
  expect(r.content).toContain('ps-works');
  expect(r.content).toContain('中文OK');
}, 30_000);

describe('PowerShell dangerous patterns', () => {
  it('Remove-Item with -Recurse and -Force is flagged (any order, any case)', () => {
    expect(flagReason('Remove-Item C:\\temp -Recurse -Force')).toBeTruthy();
    expect(flagReason('remove-item -force -recurse ./build')).toBeTruthy();
  });
  it('Set-MpPreference disabling Defender is flagged', () => {
    expect(flagReason('Set-MpPreference -DisableRealtimeMonitoring $true')).toBeTruthy();
  });
  it('taskkill /F /T is flagged', () => {
    expect(flagReason('taskkill /F /T /IM node.exe')).toBeTruthy();
  });
  it('innocuous cmdlets are NOT flagged', () => {
    expect(flagReason('Get-ChildItem -Recurse | Select-Object Name')).toBeNull();
    expect(flagReason('Get-Service | Where-Object Status -eq Running')).toBeNull();
  });
});
