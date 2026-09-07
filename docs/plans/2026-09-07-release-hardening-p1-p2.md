# Release Hardening P1+P2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把 Nova 的发版流水线补齐到主流 agent（Gemini CLI/Codex/Claude Code）的生产级水位：prerelease 通道、GitHub Release、多 OS 测试矩阵、客户端更新检查与 `/update` 命令。

**Architecture:** CI 侧拆分为 `test`（OS×Node 矩阵）与 `publish`（仅 ubuntu+node22，`needs: test`）两个 job；publish 步按 tag 是否含 `-` 决定 dist-tag（`next` vs `latest`）并在成功后创建 GitHub Release（prerelease 同步标记）。客户端侧新增 `src/update/` 模块：带 TTL 缓存的 registry 版本检查（fail-silent）+ 版本号构建期注入 + StatusBar 提示 + `/update` TUI 命令。

**Tech Stack:** TypeScript (ESM)、GitHub Actions、vitest、Ink TUI。无新增运行时依赖（semver 比较手写最小实现，spawn 走 child_process）。

---

### Task 1: prerelease dist-tag 约定（`-beta` tag 不占 latest）

**Files:**
- Modify: `.github/workflows/publish.yml`（Publish 步）

**Step 1: 修改 Publish 步，按 tag 类型决定 dist-tag**

```yaml
      - name: Publish
        id: publish
        shell: bash
        run: |
          set -o pipefail
          # Prerelease tags (contain '-') publish to dist-tag "next",
          # stable tags publish to "latest" (default).
          EXTRA_FLAGS=""
          if [[ "${GITHUB_REF_NAME}" == *-* ]]; then
            echo "prerelease tag → dist-tag: next"
            EXTRA_FLAGS="--tag next"
          fi
          npm publish --access public --provenance $EXTRA_FLAGS 2>&1 | tee /tmp/publish.log
          exit ${PIPESTATUS[0]}
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

**Step 2: 本地验证 workflow 语法**

Run: `node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/publish.yml','utf8'))"` （js-yaml 若不可用，用 `npx yaml-lint .github/workflows/publish.yml` 或目测 + push 到非 tag 分支触发 dry 验证）
Expected: 无 YAML 解析错误

**Step 3: 提交**

```bash
git add .github/workflows/publish.yml
git commit -m "ci: prerelease tags (with '-') publish to dist-tag next"
```

> 行为验证依赖 Task 2/5 完成后的真实发版（v0.1.4-beta.1），见 Task 6。

---

### Task 2: GitHub Release 自动创建

**Files:**
- Modify: `.github/workflows/publish.yml`（新增 Release 步）

**Step 1: 在 Publish + Verify 之后追加 Release 步**

```yaml
      - name: GitHub Release
        if: success()
        uses: softprops/action-gh-release@v2
        with:
          generate_release_notes: true
          prerelease: ${{ contains(github.ref_name, '-') }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

> `GITHUB_TOKEN` 是 Actions 内置注入，无需配置 Secret。`contains(ref,'-')` 与 Task 1 的 dist-tag 规则一致：`v0.1.4-beta.1` → prerelease 标记。

**Step 2: 提交**

```bash
git add .github/workflows/publish.yml
git commit -m "ci: auto-create GitHub Release with generated notes"
```

---

### Task 3: 多 OS × Node 测试矩阵

**Files:**
- Modify: `.github/workflows/publish.yml`（拆分为 test/publish 双 job）

**Step 1: 重构 workflow 为两个 job**

```yaml
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        node: [20, 22]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4   # reads packageManager from package.json
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          registry-url: "https://registry.npmjs.org/"
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Secret scan (tree + full history)
        run: node scripts/scan-secrets.mjs
      - name: Audit (prod deps, high+)
        run: pnpm audit --prod --audit-level=high
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build

  publish:
    needs: test
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: write          # GitHub Release 需要
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: "https://registry.npmjs.org/"
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - name: Publish
        # ……（Task 1 的 Publish 步原样搬入）
      - name: Verify published package (install from registry + boot)
        # ……（现有 Verify 步原样搬入）
      - name: GitHub Release
        # ……（Task 2 的 Release 步）
      - name: Dump publish log on failure
        if: failure()
        # ……（现有 Dump 步原样搬入）
```

**Step 2: Windows 已知风险点与处置**

- 所有 `run:` 步在 windows runner 默认是 pwsh——Publish/Verify/Dump 步已显式 `shell: bash`（test job 无 bash 依赖，`pnpm` 命令跨平台）
- `pnpm test` 在 Windows 上预期全绿（本地即 Windows）；若 macos 失败，常见原因是 `gatherEnvironment` 的 git 断言——修测试而非跳过
- Line endings：仓库无 `.gitattributes`，checkout 默认不转 LF（actions/checkout 不启 autocrlf），无需处理

**Step 3: 本地预检（能跑的先跑）**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: 全绿（Windows 本机 = 矩阵中的 windows+node22 组合）

**Step 4: 提交并推送（触发一次完整矩阵验证，用 beta tag 不占 latest）**

```bash
git add .github/workflows/publish.yml
git commit -m "ci: test matrix (3 OS x 2 Node) + publish gated on matrix"
npm version prerelease --preid=beta -m "chore: release v%s"
git push origin main --tags
```

**Step 5: 验证**

打开 https://github.com/deepsleepzzz0211/Nova/actions —— 6 个 test job（3OS×2Node）+ 1 publish job。
Run: `npm view @posuiqianqiu/nova dist-tags`
Expected: `latest: 0.1.x`, `next: 0.1.x-beta.n`（next 不占 latest ✓）

---

### Task 4: 客户端更新检查模块

**Files:**
- Create: `src/update/update-check.ts`
- Create: `src/update/version.d.ts`（构建期注入的版本号声明）
- Modify: `tsup.config.ts`（define 注入版本）
- Test: `tests/plan/update-check.test.ts`

**Step 1: 写失败测试**

```typescript
// tests/plan/update-check.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkForUpdate, compareSemver, readCachedUpdate } from '../../src/update/update-check.js';

let cacheDir: string;
beforeEach(() => { cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-upd-')); });
afterEach(() => { fs.rmSync(cacheDir, { recursive: true, force: true }); });

const fetchOk = (latest: string) => async () => new Response(JSON.stringify({ version: latest }), { status: 200 });

describe('compareSemver', () => {
  it('orders numeric fields', () => {
    expect(compareSemver('0.1.2', '0.1.3')).toBe(-1);
    expect(compareSemver('0.2.0', '0.1.9')).toBe(1);
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
  });
  it('prerelease is older than the same release', () => {
    expect(compareSemver('0.1.3-beta.1', '0.1.3')).toBe(-1);
  });
});

describe('checkForUpdate', () => {
  it('returns updateAvailable=true when registry is newer', async () => {
    const r = await checkForUpdate({ currentVersion: '0.1.2', fetchImpl: fetchOk('0.1.3'), cacheDir, now: Date.now() });
    expect(r).toEqual({ latest: '0.1.3', updateAvailable: true });
  });
  it('returns null when up to date (no notice)', async () => {
    const r = await checkForUpdate({ currentVersion: '0.1.3', fetchImpl: fetchOk('0.1.3'), cacheDir, now: Date.now() });
    expect(r).toBeNull();
  });
  it('fails silent on network error', async () => {
    const r = await checkForUpdate({ currentVersion: '0.1.2', fetchImpl: async () => { throw new Error('blocked'); }, cacheDir, now: Date.now() });
    expect(r).toBeNull();
  });
  it('fails silent on non-JSON response', async () => {
    const r = await checkForUpdate({ currentVersion: '0.1.2', fetchImpl: async () => new Response('Gateway Timeout', { status: 504 }), cacheDir, now: Date.now() });
    expect(r).toBeNull();
  });
});

describe('TTL cache (24h)', () => {
  it('second call within TTL does not hit the network', async () => {
    let fetches = 0;
    const fetchImpl = async () => { fetches++; return fetchOk('0.2.0')(); };
    await checkForUpdate({ currentVersion: '0.1.0', fetchImpl, cacheDir, now: 1_000_000 });
    const r = await checkForUpdate({ currentVersion: '0.1.0', fetchImpl, cacheDir, now: 1_000_000 + 23 * 3600 * 1000 });
    expect(fetches).toBe(1);                       // cache hit
    expect(r).toEqual({ latest: '0.2.0', updateAvailable: true });
  });
  it('cache expires after TTL and refetches', async () => {
    let fetches = 0;
    const fetchImpl = async () => { fetches++; return fetchOk('0.2.0')(); };
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
```

**Step 2: 跑测试确认失败**

Run: `npx vitest run tests/plan/update-check.test.ts`
Expected: FAIL（模块不存在）

**Step 3: 最小实现**

```typescript
// src/update/update-check.ts
import * as fs from 'node:fs';
import * as path from 'node:path';

/** npm dist-tag to check. */
const REGISTRY_URL = 'https://registry.npmjs.org/@posuiqianqiu/nova/latest';
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
  fetchImpl?: (url: string) => Promise<Response>;
  /** Directory for the TTL cache file (default: ~/.nova). */
  cacheDir?: string;
  /** Injectable clock (ms). */
  now?: number;
}

/** Parse "x.y.z[-pre]" into comparable parts. */
function parse(v: string): { core: [number, number, number]; pre: string | null } {
  const [core, pre = null] = v.split('-');
  const [x = 0, y = 0, z = 0] = core.split('.').map((n) => parseInt(n, 10) || 0);
  return { core: [x, y, z], pre };
}

/** Minimal semver comparison: numeric fields, then prerelease < release. */
export function compareSemver(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1;
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;  // release > prerelease
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0;
}

interface CacheFile { checkedAt: number; latest: string }

function readCached(cacheDir: string, now: number): string | null {
  try {
    const raw = fs.readFileSync(path.join(cacheDir, 'update-check.json'), 'utf-8');
    const cache = JSON.parse(raw) as CacheFile;
    if (now - cache.checkedAt < TTL_MS && typeof cache.latest === 'string') {
      return cache.latest;
    }
  } catch { /* corrupted or missing → refetch */ }
  return null;
}

function writeCache(cacheDir: string, latest: string, now: number): void {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'update-check.json'), JSON.stringify({ checkedAt: now, latest } satisfies CacheFile));
  } catch { /* cache write is best-effort */ }
}

/**
 * Check the registry for a newer version. Returns null when up to date,
 * when the network fails, or when a TTL-cached result says "no update".
 * NEVER throws — callers fire-and-forget this at startup.
 */
export async function checkForUpdate(options: CheckOptions): Promise<UpdateInfo | null> {
  const { currentVersion, now = Date.now() } = options;
  const cacheDir = options.cacheDir ?? path.join(process.env.NOVA_HOME || os.homedir(), '.nova');
  const fetchImpl = options.fetchImpl ?? ((url: string) => fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) }));

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

/** Convenience for TUI: show notice only when there is something to say. */
export async function getUpdateNotice(currentVersion: string): Promise<string | null> {
  const r = await checkForUpdate({ currentVersion });
  return r?.updateAvailable ? `update available: ${r.latest} (run /update)` : null;
}

// node:os import needed for default cacheDir
import * as os from 'node:os';
```

```typescript
// src/update/version.d.ts
declare const __NOVA_VERSION__: string;
export {};
```

```typescript
// tsup.config.ts — 顶部加读取，define 注入（保留现有配置项）
import { readFileSync } from 'fs';
const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
// define: { __NOVA_VERSION__: JSON.stringify(pkg.version) } 加进 defineConfig
```

**Step 4: 跑测试确认通过**

Run: `npx vitest run tests/plan/update-check.test.ts`
Expected: PASS（全部用例）

**Step 5: 提交**

```bash
git add src/update tests/plan/update-check.test.ts tsup.config.ts
git commit -m "feat: update-check module — TTL-cached registry check, fail-silent"
```

---

### Task 5: StatusBar 提示 + `/update` 命令

**Files:**
- Modify: `src/tui/App.tsx`（useUpdateNotice hook + StatusBar 透传）
- Create: `src/tui/hooks/useUpdateNotice.ts`
- Create: `src/update/run-update.ts`
- Modify: `src/tui/hooks/useAgent.ts`（`/update` 命令）
- Modify: `src/tui/StatusBar.tsx`（显示提示）
- Test: `tests/plan/update-command.test.ts`

**Step 1: 写失败测试**

```typescript
// tests/plan/update-command.test.ts
import { describe, it, expect } from 'vitest';
import { runNpmUpdate } from '../../src/update/run-update.js';

describe('runNpmUpdate', () => {
  it('runs npm i -g with the scoped package on the injected spawner', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const result = await runNpmUpdate({
      spawnImpl: async (cmd, args) => { calls.push({ cmd, args }); return { code: 0, output: 'added 1 package' }; },
    });
    expect(calls[0].cmd).toBe('npm');
    expect(calls[0].args).toEqual(['i', '-g', '@posuiqianqiu/nova@latest']);
    expect(result.ok).toBe(true);
  });

  it('reports failure with output', async () => {
    const result = await runNpmUpdate({
      spawnImpl: async () => ({ code: 1, output: 'E403 ...' }),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('E403');
  });
});
```

Run: `npx vitest run tests/plan/update-command.test.ts` → Expected: FAIL

**Step 2: 实现**

```typescript
// src/update/run-update.ts
import { spawn } from 'node:child_process';

export interface SpawnResult { code: number; output: string }
export type SpawnFn = (cmd: string, args: string[]) => Promise<SpawnResult>;

const DEFAULT_SPAWN: SpawnFn = (cmd, args) => new Promise((resolve) => {
  const child = spawn(cmd, args, { shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
  child.stderr?.on('data', (d: Buffer) => { output += d.toString(); });
  child.on('close', (code) => resolve({ code: code ?? 1, output }));
  child.on('error', (err) => resolve({ code: 1, output: err.message }));
});

/**
 * Run `npm i -g @posuiqianqiu/nova@latest`. The new version takes effect
 * on next launch (running process keeps its own bundle).
 */
export async function runNpmUpdate(options?: { spawnImpl?: SpawnFn }): Promise<{ ok: boolean; message: string }> {
  const spawnImpl = options?.spawnImpl ?? DEFAULT_SPAWN;
  try {
    const r = await spawnImpl('npm', ['i', '-g', '@posuiqianqiu/nova@latest']);
    if (r.code === 0) {
      return { ok: true, message: `update installed — restart nova to use it\n${r.output.trim().split('\n').slice(-3).join('\n')}` };
    }
    return { ok: false, message: `update failed:\n${r.output.trim().slice(-400)}` };
  } catch (err: unknown) {
    return { ok: false, message: `update failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
```

```typescript
// src/tui/hooks/useUpdateNotice.ts
import { useEffect, useState } from 'react';
import { getUpdateNotice } from '../../update/update-check.js';

/** Fire-and-forget update check; returns a one-line notice or null. */
export function useUpdateNotice(): string | null {
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getUpdateNotice(__NOVA_VERSION__).then((n) => {
      if (!cancelled && n) setNotice(n);
    });
    return () => { cancelled = true; };
  }, []);
  return notice;
}
```

**Step 3: 接线（App.tsx / StatusBar.tsx / useAgent.ts）**

- `App.tsx`：`const updateNotice = useUpdateNotice();` 传给 `<StatusBar updateNotice={updateNotice} />`
- `StatusBar.tsx`：props 加 `updateNotice?: string`，有值时显示黄色 `⬆ <text>`
- `useAgent.ts` sendMessage：在 `/model` 分支前加：

```typescript
    // Slash command: /update — npm i -g and report
    if (trimmed === '/update') {
      setMessages((prev) => [...prev, { role: 'system' as const, content: 'checking for updates…' }]);
      void runNpmUpdate().then((r) => {
        setMessages((prev) => [...prev, { role: 'system' as const, content: r.message }]);
      });
      return;
    }
```

**Step 4: 跑测试确认通过 + 手工验证**

Run: `npx vitest run tests/plan/update-command.test.ts && pnpm test && pnpm typecheck && pnpm build`
Expected: 全绿；`node dist/index.js` 在真实终端里 StatusBar 出现 `⬆ update available`（若 registry 有新版）

**Step 5: 提交**

```bash
git add src/update/run-update.ts src/tui tests/plan/update-command.test.ts
git commit -m "feat: update notice in StatusBar + /update command (npm i -g)"
```

---

### Task 6: 发版验证（beta → stable）

**Step 1: 提交全部剩余改动，跑完整本地门禁**

Run: `node scripts/scan-secrets.mjs && pnpm typecheck && pnpm test && pnpm build`
Expected: 全绿

**Step 2: 发 beta 验证 prerelease 通道**

```bash
npm version prerelease --preid=beta -m "chore: release v%s"
git push origin main --tags
```
Expected: CI 绿（矩阵 + publish --tag next + GitHub Release 带 prerelease 标记）；`npm view @posuiqianqiu/nova dist-tags` 显示 `next` 更新而 `latest` 不变

**Step 3: 发 stable**

```bash
npm version patch -m "chore: release v%s"
git push origin main --tags
```
Expected: CI 绿；`latest` 更新为该版本

**Step 4: 端到端验证更新检查**

Run: `npm i -g @posuiqianqiu/nova@0.1.x && node dist/index.js`（真实终端）
Expected: StatusBar 无更新提示（已是最新）；随后再发一个新版，重复启动应出现 `⬆ update available`
