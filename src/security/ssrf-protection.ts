import dns from "node:dns";

const PRIVATE_IP_RANGES: Array<{ start: number[]; end: number[] }> = [
  // 10.0.0.0/8
  { start: [10, 0, 0, 0], end: [10, 255, 255, 255] },
  // 172.16.0.0/12
  { start: [172, 16, 0, 0], end: [172, 31, 255, 255] },
  // 192.168.0.0/16
  { start: [192, 168, 0, 0], end: [192, 168, 255, 255] },
  // 127.0.0.0/8
  { start: [127, 0, 0, 0], end: [127, 255, 255, 255] },
  // 0.0.0.0/8
  { start: [0, 0, 0, 0], end: [0, 255, 255, 255] },
  // 169.254.0.0/16 (link-local)
  { start: [169, 254, 0, 0], end: [169, 254, 255, 255] },
];

function ipToBytes(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => isNaN(n) || n < 0 || n > 255)) return null;
  return nums;
}

function isIPv4Private(ip: string): boolean {
  const bytes = ipToBytes(ip);
  if (!bytes) return false;

  for (const range of PRIVATE_IP_RANGES) {
    const inRange = bytes.every(
      (b, i) => b >= range.start[i] && b <= range.end[i]
    );
    if (inRange) return true;
  }

  return false;
}

function isIPv6Private(ip: string): boolean {
  const normalized = ip.toLowerCase();

  if (
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized === "::"
  ) {
    return true;
  }

  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe80")) return true;
  if (normalized.startsWith("::ffff:")) {
    const v4Part = normalized.slice(7);
    if (isIPv4Private(v4Part)) return true;
  }

  return false;
}

export interface SsrfCheckResult {
  safe: boolean;
  error?: string;
  resolvedIp?: string;
}

export async function resolveAndValidate(host: string): Promise<SsrfCheckResult> {
  return new Promise((resolve) => {
    dns.lookup(host, { all: true }, (err, addresses) => {
      if (err) {
        resolve({ safe: false, error: `DNS lookup failed: ${err.message}` });
        return;
      }

      if (!addresses || addresses.length === 0) {
        resolve({ safe: false, error: "DNS lookup returned no addresses" });
        return;
      }

      for (const addr of addresses) {
        const ip = addr.address;

        if (isIPv4Private(ip)) {
          resolve({
            safe: false,
            error: `Blocked: ${host} resolves to private IP ${ip}`,
            resolvedIp: ip,
          });
          return;
        }

        if (isIPv6Private(ip)) {
          resolve({
            safe: false,
            error: `Blocked: ${host} resolves to private/loopback IPv6 ${ip}`,
            resolvedIp: ip,
          });
          return;
        }
      }

      resolve({ safe: true, resolvedIp: addresses[0].address });
    });
  });
}

export function validateRedirectDestination(locationHeader: string, base: URL): SsrfCheckResult | null {
  try {
    const resolved = new URL(locationHeader, base);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return { safe: false, error: `Blocked redirect to non-HTTP protocol: ${resolved.protocol}` };
    }
    return null;
  } catch {
    return { safe: false, error: `Malformed redirect location: ${locationHeader}` };
  }
}
