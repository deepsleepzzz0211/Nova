import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createWebFetchTool } from '../../src/tools/web-fetch.js';
import { resetProxyCache } from '../../src/tools/proxy.js';
import type { ToolContext } from '../../src/tools/types.js';

// web-search-batch ticket 02: SSRF guard. Blocked targets must never reach
// the network; redirects are re-checked hop by hop.

const originalFetch = globalThis.fetch;
const ctx: ToolContext = { workingDirectory: process.cwd(), abortSignal: new AbortController().signal };

interface FetchCall {
  url: string;
  redirect?: string;
}

function recordingFetch(responder?: (url: string, hop: number) => Response): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), redirect: init?.redirect });
    const responderFn = responder ?? (() => okResponse('<html><body><p>hi</p></body></html>'));
    return responderFn(String(url), calls.length - 1);
  }) as unknown as typeof fetch;
  return { calls };
}

function okResponse(body: string): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-length': String(body.length) }),
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  } as unknown as Response;
}

function redirectResponse(location: string): Response {
  return {
    ok: false,
    status: 302,
    statusText: 'Found',
    headers: new Headers({ location }),
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

const tool = createWebFetchTool();

describe('web_fetch SSRF guard (ticket 02)', () => {
  beforeEach(() => resetProxyCache());
  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetProxyCache();
  });

  const blockedUrls: Array<[string, string]> = [
    ['http://127.0.0.1/admin', 'IPv4 loopback'],
    ['http://localhost:8080/x', 'localhost name'],
    ['http://app.localhost/x', '.localhost suffix'],
    ['http://[::1]:6379/', 'IPv6 loopback'],
    ['http://10.1.2.3/', 'RFC1918 10/8'],
    ['http://192.168.0.1/', 'RFC1918 192.168/16'],
    ['http://172.16.5.5/', 'RFC1918 172.16/12'],
    ['http://169.254.169.254/latest/meta-data/', 'link-local cloud metadata'],
    ['http://[fe80::1]/', 'IPv6 link-local'],
    ['http://[fc00::1234]/', 'IPv6 ULA'],
    ['http://0.0.0.0/', 'unspecified'],
    ['http://2130706433/', 'decimal-encoded 127.0.0.1'],
    ['http://0x7f.0.0.1/', 'hex-encoded loopback'],
    ['http://metadata.google.internal/', 'GCP metadata name'],
  ];

  for (const [url, label] of blockedUrls) {
    it(`blocks ${label} without emitting a request`, async () => {
      const { calls } = recordingFetch();
      const r = await tool.execute({ url }, ctx);
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/blocked|not allowed/i);
      expect(calls).toHaveLength(0);
    });
  }

  it('172.15.x.x (just outside 172.16/12) is NOT blocked', async () => {
    const { calls } = recordingFetch();
    const r = await tool.execute({ url: 'http://172.15.0.1/' }, ctx);
    expect(r.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('public IPv6 literals still fetch', async () => {
    const { calls } = recordingFetch();
    const r = await tool.execute({ url: 'http://[2606:4700:4700::1111]/' }, ctx);
    expect(r.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('IPv4-mapped IPv6 is classified by the embedded v4 address', async () => {
    const pub = recordingFetch();
    const okR = await tool.execute({ url: 'http://[::ffff:8.8.8.8]/' }, ctx);
    expect(okR.isError).toBeUndefined();
    expect(pub.calls).toHaveLength(1);

    const priv = recordingFetch();
    const badR = await tool.execute({ url: 'http://[::ffff:127.0.0.1]/' }, ctx);
    expect(badR.isError).toBe(true);
    expect(badR.content).toMatch(/blocked/i);
    expect(priv.calls).toHaveLength(0);
  });

  it('non-http schemes (file:) are refused before any request', async () => {
    const { calls } = recordingFetch();
    const r = await tool.execute({ url: 'file:///etc/passwd' }, ctx);
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('fetches with manual redirect control so every hop is guard-checked', async () => {
    const { calls } = recordingFetch();
    await tool.execute({ url: 'https://example.com/doc' }, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0].redirect).toBe('manual');
  });

  it('a redirect into a private address is caught at the second hop', async () => {
    const { calls } = recordingFetch((url) =>
      url.includes('good.example') ? redirectResponse('http://169.254.169.254/latest/') : okResponse('x'),
    );
    const r = await tool.execute({ url: 'http://good.example/start' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/redirect/i);
    expect(r.content).toMatch(/blocked|not allowed/i);
    // Exactly one request went out (to the public URL); the internal hop was never fetched.
    expect(calls).toHaveLength(1);
  });

  it('a chain of public redirects is followed up to the hop limit', async () => {
    const { calls } = recordingFetch((_url, hop) =>
      hop < 2 ? redirectResponse(`http://hop${hop + 1}.example/`) : okResponse('<html><body><p>final</p></body></html>'),
    );
    const r = await tool.execute({ url: 'http://start.example/' }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('final');
    expect(calls).toHaveLength(3); // start → hop1 → hop2(final)
  });

  it('too many redirects errors instead of looping forever', async () => {
    const { calls } = recordingFetch(() => redirectResponse('http://loop.example/again'));
    const r = await tool.execute({ url: 'http://loop.example/start' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/too many redirects/i);
    expect(calls.length).toBeLessThanOrEqual(6);
  });
});
