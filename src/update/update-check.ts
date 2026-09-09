/** npm 包标识（单一来源，供 registry 查询与全局安装共用）。 */
import { PACKAGE_NAME } from './constants.js';
import { novaHome } from '../config/loader.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';


/** npm dist-tag to check. */
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
/** Update-check cache TTL (24h, same policy as Gemini CLI). */
const TTL_MS = 24 * 60 * 60 * 1000;
/** Network timeout — never block startup on this. */
const TIMEOUT_MS = 3000;

export interface UpdateInfo {
  latest: string;
  updateAvailable: boolean;
}

export interface CheckOptions {
  currentVersion: string;
  /** Injectable fetch (tests). Defaults to global fetch with a 3s timeout. */
  fetchImpl?: (url: string) => Promise<Response>;
  /** Directory for the TTL cache file (default: <nova-home>/.nova). */
  cacheDir?: string;
  /** Injectable clock (ms). */
  now?: number;
}

interface ParsedVersion {
  core: [number, number, number];
  pre: string | null;
}

function parseVersion(v: string): ParsedVersion {
  const [core, pre = null] = v.split('-');
  const parts = core.split('.').map((n) => parseInt(n, 10) || 0);
  return { core: [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0], pre };
}

/**
 * Numeric-aware prerelease comparison: `beta.10` > `beta.2`
 * (falls back to string ordering for non-numeric tails).
 */
function comparePrerelease(a: string, b: string): number {
  const na = Number(a.split('.').pop());
  const nb = Number(b.split('.').pop());
  if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) {
    return na < nb ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Minimal semver comparison: numeric fields, then prerelease < release. */
export function compareSemver(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1;
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1; // release > prerelease
  if (pb.pre === null) return -1;
  return comparePrerelease(pa.pre, pb.pre);
}

interface CacheFile {
  checkedAt: number;
  latest: string;
}

function readCached(cacheDir: string, now: number): string | null {
  try {
    const raw = fs.readFileSync(path.join(cacheDir, 'update-check.json'), 'utf-8');
    const cache = JSON.parse(raw) as CacheFile;
    if (now - cache.checkedAt < TTL_MS && typeof cache.latest === 'string') {
      return cache.latest;
    }
  } catch {
    // corrupted or missing → refetch
  }
  return null;
}

function writeCache(cacheDir: string, latest: string, now: number): void {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, 'update-check.json'),
      JSON.stringify({ checkedAt: now, latest } satisfies CacheFile),
    );
  } catch {
    // cache write is best-effort
  }
}

/**
 * Check the registry for a newer version. Returns null when up to date,
 * when the network fails, or when a TTL-cached result says "no update".
 * NEVER throws — callers fire-and-forget this at startup.
 */
export async function checkForUpdate(options: CheckOptions): Promise<UpdateInfo | null> {
  const { currentVersion, now = Date.now() } = options;
  const cacheDir = options.cacheDir ?? path.join(novaHome(), '.nova');
  const fetchImpl =
    options.fetchImpl ??
    ((url: string) => fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) }));

  let latest = readCached(cacheDir, now);
  if (latest === null) {
    try {
      const response = await fetchImpl(REGISTRY_URL);
      if (!response.ok) return null;
      const data = (await response.json()) as { version?: string };
      if (typeof data.version !== 'string') return null;
      latest = data.version;
      writeCache(cacheDir, latest, now);
    } catch {
      return null; // fail-silent: network must never block or break startup
    }
  }

  return compareSemver(currentVersion, latest) < 0
    ? { latest, updateAvailable: true }
    : null;
}

/** Convenience for the TUI: a one-line notice, or null when silent. */
export async function getUpdateNotice(currentVersion: string): Promise<string | null> {
  const r = await checkForUpdate({ currentVersion });
  return r?.updateAvailable ? `⬆ update available: ${r.latest} (run /update)` : null;
}

/**
 * Build-time injected version (tsup define). Resolved here so callers
 * don't reach for globals.
 */
export function currentVersion(): string {
  return __NOVA_VERSION__;
}

