import { describe, expect, it, vi } from "vitest";
import { BlockedAddressError, checkWebhookUrl, createPinnedLookup, isBlockedAddress } from "./ssrf";

describe("checkWebhookUrl", () => {
  it("accepts a normal public https URL", () => {
    const result = checkWebhookUrl("https://hooks.example.com/selo");
    expect(result.ok).toBe(true);
  });

  it("refuses http, even though a signature would still be attached", () => {
    expect(checkWebhookUrl("http://hooks.example.com/x")).toEqual({ ok: false, reason: "not_https" });
  });

  it("refuses a non-443 port", () => {
    expect(checkWebhookUrl("https://hooks.example.com:8443/x")).toEqual({ ok: false, reason: "bad_port" });
  });

  it("refuses credentials in the URL", () => {
    expect(checkWebhookUrl("https://user:pw@hooks.example.com/x")).toEqual({
      ok: false,
      reason: "has_userinfo",
    });
  });

  it("refuses IP literals outright, v4 and v6", () => {
    expect(checkWebhookUrl("https://93.184.216.34/x")).toEqual({ ok: false, reason: "ip_literal" });
    expect(checkWebhookUrl("https://[2606:2800:220:1:248:1893:25c8:1946]/x")).toEqual({
      ok: false,
      reason: "ip_literal",
    });
  });

  it("refuses internal-looking hostnames", () => {
    for (const url of [
      "https://localhost/x",
      "https://api.localhost/x",
      "https://svc.internal/x",
      "https://db.cluster.local/x",
      "https://thing.svc/x",
      "https://printer.local/x",
      "https://intranet/x",
    ]) {
      expect(checkWebhookUrl(url).ok).toBe(false);
    }
  });
});

describe("isBlockedAddress", () => {
  it("allows public unicast", () => {
    expect(isBlockedAddress("93.184.216.34")).toBe(false);
    expect(isBlockedAddress("8.8.8.8")).toBe(false);
    expect(isBlockedAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
  });

  it("blocks the cloud metadata endpoint, the canonical SSRF target", () => {
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
  });

  it("blocks every private, loopback, link-local, CGNAT, reserved and multicast v4 range", () => {
    for (const address of [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.1.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.1",
      "192.0.2.1",
      "192.88.99.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it("does not over-block v4 addresses adjacent to a blocked range", () => {
    expect(isBlockedAddress("172.15.255.255")).toBe(false);
    expect(isBlockedAddress("172.32.0.1")).toBe(false);
    expect(isBlockedAddress("100.63.255.255")).toBe(false);
    expect(isBlockedAddress("11.0.0.1")).toBe(false);
  });

  it("blocks loopback, unique-local, link-local and multicast v6", () => {
    for (const address of ["::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1"]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it("blocks IPv4-mapped v6 by re-validating the embedded v4 address", () => {
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedAddress("::ffff:93.184.216.34")).toBe(false);
  });

  it("strips a scope id before deciding -- fe80::1%eth0 is still link-local", () => {
    expect(isBlockedAddress("fe80::1%eth0")).toBe(true);
  });

  it("blocks anything that is not an address at all", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
  });
});

describe("createPinnedLookup", () => {
  function run(addresses: { address: string; family: number }[]) {
    const lookup = createPinnedLookup(async () => addresses);
    return new Promise<{ err: NodeJS.ErrnoException | null; address?: unknown }>((resolve) => {
      lookup("host.example.com", {}, (err, address) => resolve({ err, address }));
    });
  }

  it("returns the first address when every address is public", async () => {
    const { err, address } = await run([{ address: "93.184.216.34", family: 4 }]);
    expect(err).toBeNull();
    expect(address).toBe("93.184.216.34");
  });

  it("rejects when ANY resolved address is private -- a host returning one public and one private address is a rebinding attempt, not a multi-homed service", async () => {
    const { err } = await run([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    expect(err).toBeInstanceOf(BlockedAddressError);
    expect(err?.code).toBe("EBLOCKED");
  });

  it("rejects an empty resolution rather than connecting to nothing", async () => {
    const { err } = await run([]);
    expect(err?.code).toBe("ENOTFOUND");
  });

  it("resolves exactly once per connection, so nothing can change between check and connect", async () => {
    const resolver = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const lookup = createPinnedLookup(resolver);
    await new Promise<void>((resolve) => lookup("host.example.com", {}, () => resolve()));
    expect(resolver).toHaveBeenCalledTimes(1);
  });
});
