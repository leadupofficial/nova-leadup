import { URL } from 'url';

const BLOCKED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
]);

/**
 * Validates that a URL is safe to fetch from the server.
 *
 * Rules:
 *  1. Must be absolute http(s) URL.
 *  2. Hostname must not be blocked (localhost, loopback, 0.0.0.0).
 *  3. Hostname must not resolve to a private / reserved / link-local IPv4 range:
 *      10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16,
 *      127.0.0.0/8, 0.0.0.0/8, 100.64.0.0/10, 198.18.0.0/15
 *  4. Hostname must not resolve to a private / reserved / link-local IPv6 range:
 *      ::1/128, fc00::/7, fe80::/10
 *  5. Port must not be a well-known sensitive port (22, 23, 3306, 5432, 6379, 9200, 27017, etc.)
 */
export function isUrlSafe(raw: string): { safe: true } | { safe: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { safe: false, reason: 'Invalid URL format' };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { safe: false, reason: `Protocol "${parsed.protocol}" is not allowed` };
  }

  const host = parsed.hostname.toLowerCase();

  // IPv4 / IPv6 numeric checks first so IPs get consistent "private" reasons
  const ipv4Candidate = host.replace(/^\[|\]$/g, '');
  if (isPrivateIPv4(ipv4Candidate)) {
    return { safe: false, reason: `Private/reserved IPv4 address "${ipv4Candidate}" is blocked` };
  }
  if (isPrivateIPv6(host)) {
    return { safe: false, reason: `Private/reserved IPv6 address "${host}" is blocked` };
  }

  // Then hostname blocklist for symbolic names
  if (BLOCKED_HOSTS.has(host)) {
    return { safe: false, reason: `Host "${host}" is blocked` };
  }

  // Block sensitive ports commonly used for internal services
  if (parsed.port) {
    const port = parseInt(parsed.port, 10);
    const sensitivePorts = [22, 23, 3306, 5432, 6379, 9200, 27017, 11211, 27018];
    if (sensitivePorts.includes(port)) {
      return { safe: false, reason: `Port ${port} is blocked for security reasons` };
    }
  }

  return { safe: true };
}

function isPrivateIPv4(ip: string): boolean {
  // Validate it's actually an IPv4 address
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return false;
  }

  const [a, b] = parts.map(Number);

  // 0.0.0.0/8, 10.0.0.0/8
  if (a === 0 || a === 10) return true;
  // 127.0.0.0/8
  if (a === 127) return true;
  // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 (network benchmark tests)
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 100.64.0.0/10 (carrier-grade NAT)
  if (a === 100 && b >= 64 && b <= 127) return true;

  return false;
}

function isPrivateIPv6(host: string): boolean {
  // Strip brackets if present
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();

  // ::1 (loopback)
  if (normalized === '::1') return true;

  // fc00::/7 (unique local)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;

  // fe80::/10 (link-local)
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
    return true;
  }

  return false;
}
