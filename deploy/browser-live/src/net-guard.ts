import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// SSRF guard for the Test Browser. The browser runs inside our network, so a tester could otherwise
// point it at cloud metadata (169.254.169.254) or internal services. Every request the page makes is
// checked after DNS resolution, which also covers redirects, popups and subresources. Infrastructure
// isolation (runner subnets with no route inward, technical-design §10) remains the second layer:
// this check cannot stop a DNS answer that changes between our lookup and Chromium's.

const V4_BLOCKED: [number, number][] = [
  [0x00000000, 8], // 0.0.0.0/8
  [0x0a000000, 8], // 10/8
  [0x64400000, 10], // 100.64/10 carrier-grade NAT
  [0x7f000000, 8], // 127/8 loopback
  [0xa9fe0000, 16], // 169.254/16 link-local, cloud metadata
  [0xac100000, 12], // 172.16/12
  [0xc0a80000, 16], // 192.168/16
  [0xc6120000, 15], // 198.18/15 benchmarking
  [0xe0000000, 4], // multicast
  [0xf0000000, 4], // reserved
];

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

/** True for loopback, private, link-local, carrier-NAT, multicast and reserved addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const n = v4ToInt(ip);
    return V4_BLOCKED.some(([base, bits]) => (n & (bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0)) >>> 0 === base);
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivateAddress(mapped[1]!);
  // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast.
  return /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff');
}

const cache = new Map<string, { at: number; blocked: boolean }>();
const TTL_MS = 60_000;

/** Whether a hostname resolves to any blocked address. Unresolvable names are left to the browser. */
export async function isBlockedHost(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return isPrivateAddress(host);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return true;
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.blocked;
  const blocked = await lookup(host, { all: true, verbatim: true }).then(
    (addrs) => addrs.some((a) => isPrivateAddress(a.address)),
    () => false,
  );
  cache.set(host, { at: Date.now(), blocked });
  return blocked;
}
