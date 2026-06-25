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
];
