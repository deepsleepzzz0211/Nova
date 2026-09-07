import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkForUpdate, compareSemver } from '../../src/update/update-check.js';

let cacheDir: string;
beforeEach(() => { cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-upd-')); });
afterEach(() => { fs.rmSync(cacheDir, { recursive: true, force: true }); });

const fetchOk = (latest: string) => async (): Promise<Response> =>
  new Response(JSON.stringify({ version: latest }), { status: 200 });

describe('compareSemver', () => {
  it('orders numeric fields', () => {
    expect(compareSemver('0.1.2', '0.1.3')).toBe(-1);
    expect(compareSemver('0.2.0', '0.1.9')).toBe(1);
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
  });

  it('prerelease tails compare numerically (beta.10 > beta.2)', () => {
    expect(compareSemver('0.1.3-beta.10', '0.1.3-beta.2')).toBe(1);
    expect(compareSemver('0.1.3-beta.2', '0.1.3-beta.10')).toBe(-1);
  });

  it('prerelease is older than the same release', () => {
    expect(compareSemver('0.1.3-beta.1', '0.1.3')).toBe(-1);
    expect(compareSemver('0.1.3', '0.1.3-beta.1')).toBe(1);
  });
});

describe('checkForUpdate', () => {
  it('returns updateAvailable=true when registry is newer', async () => {
    const r = await checkForUpdate({ currentVersion: '0.1.2', fetchImpl: fetchOk('0.1.3'), cacheDir, now: 1_000_000 });
    expect(r).toEqual({ latest: '0.1.3', updateAvailable: true });
  });

  it('returns null when up to date (no notice)', async () => {
    const r = await checkForUpdate({ currentVersion: '0.1.3', fetchImpl: fetchOk('0.1.3'), cacheDir, now: 1_000_000 });
    expect(r).toBeNull();
  });

  it('fails silent on network error', async () => {
    const r = await checkForUpdate({
      currentVersion: '0.1.2',
      fetchImpl: async () => { throw new Error('blocked'); },
      cacheDir,
      now: 1_000_000,
    });
    expect(r).toBeNull();
  });

  it('fails silent on non-JSON / error status response', async () => {
    const r = await checkForUpdate({
      currentVersion: '0.1.2',
      fetchImpl: async () => new Response('Gateway Timeout', { status: 504 }),
      cacheDir,
      now: 1_000_000,
    });
    expect(r).toBeNull();
  });
});

describe('TTL cache (24h)', () => {
  it('second call within TTL does not hit the network', async () => {
    let fetches = 0;
    const fetchImpl = async (): Promise<Response> => { fetches++; return fetchOk('0.2.0')(); };
    await checkForUpdate({ currentVersion: '0.1.0', fetchImpl, cacheDir, now: 1_000_000 });
    const r = await checkForUpdate({ currentVersion: '0.1.0', fetchImpl, cacheDir, now: 1_000_000 + 23 * 3600 * 1000 });
    expect(fetches).toBe(1); // cache hit
    expect(r).toEqual({ latest: '0.2.0', updateAvailable: true });
  });

  it('cache expires after TTL and refetches', async () => {
    let fetches = 0;
    const fetchImpl = async (): Promise<Response> => { fetches++; return fetchOk('0.2.0')(); };
    await checkForUpdate({ currentVersion: '0.1.0', fetchImpl, cacheDir, now: 1_000_000 });
    await checkForUpdate({ currentVersion: '0.1.0', fetchImpl, cacheDir, now: 1_000_000 + 25 * 3600 * 1000 });
    expect(fetches).toBe(2);
  });

  it('corrupted cache file is ignored (fail-open refetch)', async () => {
    fs.writeFileSync(path.join(cacheDir, 'update-check.json'), '{corrupt');
    const r = await checkForUpdate({ currentVersion: '0.1.0', fetchImpl: fetchOk('0.2.0'), cacheDir, now: 1_000_000 });
    expect(r).toEqual({ latest: '0.2.0', updateAvailable: true });
  });
});
