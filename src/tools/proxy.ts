import { ProxyAgent, fetch as undiciFetch, type Dispatcher, type RequestInit as UndiciRequestInit } from 'undici';

/**
 * HTTP fetch helper with HTTP(S) proxy support for the web tools.
 *
 * Node's global fetch ignores HTTP_PROXY/HTTPS_PROXY environment variables.
 * When a proxy is configured (standard env vars), requests go through an
 * undici ProxyAgent; otherwise the global fetch is used unchanged.
 */

let cachedProxyUrl: string | null | undefined;
let cachedDispatcher: ProxyAgent | undefined;

function detectProxyUrl(): string | null {
  if (cachedProxyUrl !== undefined) return cachedProxyUrl;
  const url =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy ??
    '';
  cachedProxyUrl = url.trim() ? url.trim() : null;
  return cachedProxyUrl;
}

/** Reset the cached proxy detection (mainly for tests). */
export function resetProxyCache(): void {
  cachedProxyUrl = undefined;
  cachedDispatcher = undefined;
}

/** True when a proxy is configured via environment variables. */
export function hasProxy(): boolean {
  return detectProxyUrl() !== null;
}

/**
 * Fetch with proxy support. Signature-compatible with global fetch for
 * the web tools' usage (string url + init, returns Response).
 */
export async function proxyAwareFetch(url: string, init?: RequestInit): Promise<Response> {
  const proxyUrl = detectProxyUrl();
  if (!proxyUrl) {
    return globalThis.fetch(url, init);
  }
  cachedDispatcher ??= new ProxyAgent(proxyUrl);
  const response = await undiciFetch(url, {
    ...(init as UndiciRequestInit | undefined),
    dispatcher: cachedDispatcher as unknown as Dispatcher,
  });
  return response as unknown as Response;
}
