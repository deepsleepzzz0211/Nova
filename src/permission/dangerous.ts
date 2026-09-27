/** Dangerous shell command patterns that should trigger user confirmation. */
export const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[rRf]+\b|--recursive)/, reason: 'Recursive file deletion' },
  { pattern: /\bgit\s+push\s+.*--force/, reason: 'Force push' },
  { pattern: /\bmkfs\b/, reason: 'Disk formatting' },
  { pattern: /\bdd\s+/, reason: 'Raw disk write' },
  { pattern: /\bchmod\s+777/, reason: 'World-writable permissions' },
  { pattern: /\b(curl|wget)\s+.*\|\s*(bash|sh|python|node)/, reason: 'Remote content to shell' },
  { pattern: /\bsudo\b/, reason: 'Elevated privileges' },
  { pattern: /\b(shutdown|reboot|halt)\b/, reason: 'System shutdown' },
  { pattern: />\s*\/dev\/sd[a-z]/, reason: 'Writing to disk device' },
  { pattern: /\bkill\s+-9\s+1\b/, reason: 'Killing init process' },
  // PowerShell forms (windows-shell 03). PS is case-insensitive, so these
  // carry /i; POSIX patterns above deliberately keep their case sensitivity.
  {
    pattern: /\bRemove-Item\b[^\n]*-Recurse\b[^\n]*-Force\b|\bRemove-Item\b[^\n]*-Force\b[^\n]*-Recurse\b/i,
    reason: 'PowerShell recursive forced deletion',
  },
  { pattern: /\bSet-MpPreference\b[^\n]*-Disable/i, reason: 'Disabling Microsoft Defender protection' },
  { pattern: /\btaskkill\b[^\n]*\/[Ff]\b[^\n]*\/[Tt]\b|\btaskkill\b[^\n]*\/[Tt]\b[^\n]*\/[Ff]\b/, reason: 'Forced tree process kill' },
  { pattern: /\bClear-RecycleBin\b/i, reason: 'Emptying the Recycle Bin' },
];
