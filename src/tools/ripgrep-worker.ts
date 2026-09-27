import { Worker } from 'node:worker_threads';
import type { RipgrepResult } from './ripgrep-search.js';

/**
 * Executes the ripgrep WASM engine off the main thread (search-tools ticket 01).
 *
 * The WASM run is synchronous inside whatever thread hosts it — a pathological
 * tree would freeze the TUI for minutes — so every search gets a worker whose
 * lifetime is bounded by two exit guarantees: an explicit timeout and the
 * caller's AbortSignal, both enforced by terminating the worker (the only way
 * to interrupt a running WASM call). The engine module is resolved on the
 * main thread (import.meta.resolve works from the installed package layout)
 * and handed to the worker as a file URL — the worker source is an eval string
 * so tsup's single-file bundle keeps working without sibling assets.
 */

/** Source of the eval worker: message-per-search, one ripgrep call per message. */
const WORKER_SOURCE = `
const { workerData, parentPort } = require('node:worker_threads');
parentPort.on('message', async (msg) => {
  try {
    const { ripgrep } = await import(workerData.specifier);
    const res = await ripgrep(msg.args, { buffer: true, env: {} });
    parentPort.postMessage({ id: msg.id, ok: true, code: res.code, stdout: res.stdout, stderr: res.stderr });
  } catch (err) {
    parentPort.postMessage({ id: msg.id, ok: false, error: String((err && err.message) || err) });
  }
});
`;

/** Run one ripgrep invocation with the given argv. Rejects on timeout/cancel. */
export function runRipgrep(
  args: readonly string[],
  options: { signal: AbortSignal; timeoutMs: number },
): Promise<RipgrepResult> {
  const { signal, timeoutMs } = options;
  if (signal.aborted) {
    return Promise.reject(new Error('ripgrep search was cancelled before it started'));
  }
  const specifier = import.meta.resolve('ripgrep');
  const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { specifier } });

  return new Promise<RipgrepResult>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      void worker.terminate();
      fn();
    };
    const onAbort = (): void => settle(() => reject(new Error('ripgrep search was cancelled')));
    const timer = setTimeout(
      () => settle(() => reject(new Error(`ripgrep search timed out after ${timeoutMs}ms`))),
      timeoutMs,
    );
    timer.unref?.();

    worker.on('message', (msg: { id: number; ok: boolean; code?: number; stdout?: string; stderr?: string; error?: string }) => {
      if (!msg.ok) {
        settle(() => reject(new Error(`ripgrep worker failed: ${msg.error ?? 'unknown error'}`)));
        return;
      }
      settle(() => resolve({ code: msg.code ?? 2, stdout: msg.stdout ?? '', stderr: msg.stderr ?? '' }));
    });
    worker.on('error', (err: Error) => settle(() => reject(new Error(`ripgrep worker crashed: ${err.message}`))));
    signal.addEventListener('abort', onAbort, { once: true });
    worker.postMessage({ id: 1, args });
  });
}
