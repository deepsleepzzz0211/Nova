/**
 * SSRF guard for outbound fetches made on the user's machine.
 *
 * The web tools turn a model-chosen URL into a request that originates
 * INSIDE the user's network, so any loopback / private / link-local /
 * reserved target (cloud metadata endpoints above all) must be refused
 * before a single packet leaves. Classify the WHATWG-normalized hostname:
 * decimal/hex/octal IPv4 encodings collapse to dotted form here, which is
 * exactly why we parse first and pattern-match after.
 */

/** Returns a human reason when the target must not be fetched, else null. */
export function blockedFetchReason(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return `invalid URL ${JSON.stringify(rawUrl)}`;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `scheme ${parsed.protocol} is not allowed (http/https only)`;
  }

  const host = parsed.hostname.toLowerCase();
  const v6 = /^\[(.*)\]$/.exec(host);
  if (v6) {
    return blockedIpv6Reason(v6[1]);
  }

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return `host ${host} resolves to this machine`;
  }
  if (host === 'metadata.google.internal' || host.endsWith('.metadata.google.internal')) {
    return `host ${host} is a cloud metadata endpoint`;
  }

  return blockedIpv4Reason(host);
}

function blockedIpv4Reason(host: string): string | null {
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!octets) return null;
  const [a, b] = octets.slice(1).map(Number);
  if (a === 127) return `address ${host} is loopback`;
  if (a === 10) return `address ${host} is private (10/8)`;
  if (a === 172 && b >= 16 && b <= 31) return `address ${host} is private (172.16/12)`;
  if (a === 192 && b === 168) return `address ${host} is private (192.168/16)`;
  if (a === 169 && b === 254) return `address ${host} is link-local (cloud metadata)`;
  if (a === 0) return `address ${host} is unspecified`;
  if (a === 100 && b >= 64 && b <= 127) return `address ${host} is carrier-grade NAT (100.64/10)`;
  if (a >= 224) return `address ${host} is multicast/reserved`;
  return null;
}

function blockedIpv6Reason(host: string): string | null {
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return `address [${host}] is loopback`;
  if (host === '::') return `address [${host}] is unspecified`;
  // WHATWG normalizes ::ffff:a.b.c.d to the hex form (::ffff:808:808 for
  // 8.8.8.8), so the embedded address must be decoded from two hextets.
  const mapped = /^::ffff:(.+)$/.exec(host);
  if (mapped) {
    const inner = mapped[1];
    const hexPair = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(inner);
    let dotted = inner;
    if (hexPair) {
      const hi = parseInt(hexPair[1], 16);
      const lo = parseInt(hexPair[2], 16);
      dotted = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    }
    const reason = blockedIpv4Reason(dotted);
    return reason ? `address [${host}] wraps an internal IPv4 (${reason})` : null;
  }
  const first = host.split(':')[0]?.toLowerCase() ?? '';
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^f[cd]/.test(first)) {
    return `address [${host}] is unique-local (fc00::/7)`;
  }
  if (/^fe[89ab]/.test(first)) {
    return `address [${host}] is link-local (fe80::/10)`;
  }
  return null;
}
