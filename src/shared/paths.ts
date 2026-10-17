/** Convert Windows separators to forward slashes (the form both our WASM
 *  engine guest and every model-facing path in Nova use). */
export function toSlashes(p: string): string {
  return p.split('\\').join('/');
}

/** Windows path -> Git-Bash/MSYS form (C:\x\y -> /c/x/y). Non-drive paths
 *  pass through, so POSIX callers get the identity. */
export function windowsPathToGitBashPath(p: string): string {
  const m = /^([A-Za-z]):([\\/].*)?$/.exec(p);
  if (!m) return p;
  const rest = (m[2] ?? '').replace(/\\/g, '/');
  return `/${m[1].toLowerCase()}${rest}`;
}

/** Git-Bash/MSYS form -> Windows path (/c/x/y -> C:\x\y). Non-drive paths
 *  pass through. */
export function gitBashPathToWindowsPath(p: string): string {
  const m = /^\/([A-Za-z])(\/.*)?$/.exec(p);
  if (!m) return p;
  const rest = (m[2] ?? '').replace(/\//g, '\\');
  return `${m[1].toUpperCase()}:${rest}`;
}
