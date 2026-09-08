import "server-only";
import { isIP } from "node:net";

/**
 * SSRF policy for outbound webhook delivery.
 *
 * A webhook runner is, by definition, a service that makes HTTP requests to URLs supplied by
 * users. That is the textbook shape of SSRF, so the rules here are mandatory rather than
 * advisory, and they are applied at TWO points:
 *
 *   1. when an endpoint is created  -- structural checks on the URL;
 *   2. at connection time            -- every resolved IP is validated and the connection is
 *                                       PINNED to a validated address.
 *
 * Step 2 is not optional decoration. DNS rebinding changes what a hostname resolves to
 * between the check and the connect, so validating at creation time alone leaves the entire
 * policy decorative. See createPinnedLookup().
 *
 * The final decision is an ALLOWLIST -- the address must be a globally routable public
 * unicast address -- rather than a denylist, because a denylist always forgets a range.
 */

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".cluster.local",
  ".svc",
  ".home.arpa",
];

export type UrlRejection =
  | "not_https"
  | "bad_port"
  | "has_userinfo"
  | "ip_literal"
  | "internal_hostname"
  | "too_long"
  | "unparseable";

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: UrlRejection };

/**
 * Structural validation. Deliberately refuses IP literals outright: an endpoint that names
 * an address rather than a host has no legitimate use here, and allowing them would mean
 * re-implementing the whole address policy twice.
 */
export function checkWebhookUrl(raw: string): UrlCheck {
  if (raw.length > 2000) return { ok: false, reason: "too_long" };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "unparseable" };
  }

  // No http:// even in a test environment, and no flag to relax it. A signed payload sent
  // in cleartext is an unsigned payload with extra steps.
  if (url.protocol !== "https:") return { ok: false, reason: "not_https" };
  if (url.port !== "" && url.port !== "443") return { ok: false, reason: "bad_port" };
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "has_userinfo" };

  // WHATWG URL keeps the brackets on an IPv6 host ("[::1]"), and isIP() does not recognise
  // a bracketed address -- so without stripping them, an IPv6 literal fell through the
  // ip_literal check entirely. It was still refused, but only by the "must contain a dot"
  // heuristic below, which an IPv4-mapped literal like [::ffff:127.0.0.1] satisfies. Found
  // by the test in ssrf.test.ts, not by reading the code.
  const host = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[(.*)\]$/, "$1");
  if (isIP(host) !== 0) return { ok: false, reason: "ip_literal" };
  if (host === "localhost") return { ok: false, reason: "internal_hostname" };
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { ok: false, reason: "internal_hostname" };
  }
  if (!host.includes(".")) return { ok: false, reason: "internal_hostname" };

  return { ok: true, url };
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** Every range that is not globally routable public unicast. 169.254.169.254 -- the cloud
 * metadata endpoint, and the canonical SSRF target -- falls inside 169.254.0.0/16. */
const BLOCKED_IPV4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function isBlockedIpv4(address: string): boolean {
  const value = ipv4ToInt(address);
  if (value === null) return true;
  for (const [base, bits] of BLOCKED_IPV4) {
    const baseValue = ipv4ToInt(base);
    if (baseValue === null) return true;
    const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
    if ((value & mask) >>> 0 === (baseValue & mask) >>> 0) return true;
  }
  return false;
}

function isBlockedIpv6(address: string): boolean {
  // A scope id (fe80::1%eth0) is stripped before parsing; it never makes an address routable.
  const lower = address.toLowerCase().split("%")[0] ?? "";

  // An IPv4-mapped address is an IPv4 address wearing a hat. Re-validate it as one instead
  // of trying to express the IPv4 ranges a second time in IPv6 notation.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  const mappedV4 = mapped?.[1];
  if (mappedV4 !== undefined) return isBlockedIpv4(mappedV4);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(lower)) return true; // hex form of the same thing

  if (lower === "::" || lower === "::1") return true;

  const head = lower.split(":")[0] ?? "";
  const headValue = head === "" ? 0 : parseInt(head, 16);
  if (Number.isNaN(headValue)) return true;

  if ((headValue & 0xfe00) === 0xfc00) return true; // fc00::/7  unique local
  if ((headValue & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((headValue & 0xff00) === 0xff00) return true; // ff00::/8  multicast

  return false;
}

/** The single decision point. Anything that is not a public unicast address is refused. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true; // not an address at all
}

export class BlockedAddressError extends Error {
  constructor(readonly address: string) {
    // The address is included because it is our own diagnostic, never returned to a
    // subscriber or stored in a tenant-visible field.
    super(`blocked address: ${address}`);
    this.name = "BlockedAddressError";
  }
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | { address: string; family: number }[],
  family?: number,
) => void;

/**
 * A drop-in `lookup` for node:https that resolves the hostname, validates EVERY returned
 * address, and hands back one validated address to connect to. Because the http client
 * connects to the address this function returns -- and never re-resolves -- there is no
 * window between validation and connection for DNS rebinding to exploit.
 *
 * TLS still uses the original hostname for SNI and certificate verification, which is why
 * this is done through node:https's lookup hook rather than by rewriting the URL to an IP
 * (which would break certificate validation and force us to disable it).
 */
export function createPinnedLookup(
  resolver: (hostname: string) => Promise<{ address: string; family: number }[]>,
) {
  return function pinnedLookup(hostname: string, options: unknown, callback: LookupCallback): void {
    // Node calls this hook with `{ all: true }` on some paths and then expects an ARRAY
    // back; returning a scalar there makes it read `.address` of a non-array and fail with
    // "Invalid IP address: undefined". That is not an edge case -- it made EVERY webhook
    // delivery fail at the connection layer, which only showed up once a real delivery was
    // attempted against a real host. Honour whatever shape Node asked for.
    const wantsAll =
      typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;

    resolver(hostname)
      .then((addresses) => {
        if (addresses.length === 0) {
          callback(Object.assign(new Error(`no address for ${hostname}`), { code: "ENOTFOUND" }));
          return;
        }
        // Every address must pass, not just the one we pick: a host that returns one public
        // and one private address is a rebinding attempt, not a multi-homed service.
        for (const entry of addresses) {
          if (isBlockedAddress(entry.address)) {
            callback(Object.assign(new BlockedAddressError(entry.address), { code: "EBLOCKED" }));
            return;
          }
        }
        // Every address was validated above, so handing back the whole set is safe -- Node
        // may try them in order and each one is already known to be public unicast.
        if (wantsAll) {
          callback(null, addresses);
          return;
        }

        const chosen = addresses[0];
        if (chosen === undefined) {
          callback(Object.assign(new Error(`no address for ${hostname}`), { code: "ENOTFOUND" }));
          return;
        }
        callback(null, chosen.address, chosen.family);
      })
      .catch((error: unknown) => {
        callback(
          error instanceof Error
            ? Object.assign(error, { code: (error as NodeJS.ErrnoException).code ?? "EAI_AGAIN" })
            : Object.assign(new Error("dns failure"), { code: "EAI_AGAIN" }),
        );
      });
  };
}
