import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "../../src/config/errors.js";
import type { ElegantiaAntipatternInput } from "../../src/elegantia/antipattern-payload.js";
import { ElegantiaClient, ElegantiaRequestError } from "../../src/elegantia/elegantia-client.js";

const INPUT: ElegantiaAntipatternInput = {
  sourceRef: "genius:card:01CARD",
  title: "t",
  summary: "s",
  detect: ["d"],
  fix: "f",
  tags: [],
  augur: null,
};

function client(fetchImpl: typeof fetch): ElegantiaClient {
  return new ElegantiaClient({ baseUrl: "http://127.0.0.1:17999", timeoutMs: 1_000, fetch: fetchImpl });
}

describe("ElegantiaClient", () => {
  it("posts the payload and accepts both created (201) and existing (200)", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ id: "AP-G-1", created: true }), { status: 201 }));
    await expect(client(fetchImpl as typeof fetch).register(INPUT))
      .resolves.toEqual({ id: "AP-G-1", created: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("http://127.0.0.1:17999/api/antipatterns");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(INPUT);

    const existing = vi.fn(async () =>
      new Response(JSON.stringify({ id: "AP-G-1", created: false }), { status: 200 }));
    await expect(client(existing as typeof fetch).register(INPUT))
      .resolves.toEqual({ id: "AP-G-1", created: false });
  });

  it("throws on non-2xx, malformed bodies and unreachable hosts", async () => {
    const failing = vi.fn(async () => new Response("secret body", { status: 400 }));
    const error = await client(failing as typeof fetch).register(INPUT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ElegantiaRequestError);
    expect(String((error as Error).message)).not.toContain("secret body");

    const malformed = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 201 }));
    await expect(client(malformed as typeof fetch).register(INPUT)).rejects.toThrow(/unexpected/);

    const down = vi.fn(async () => { throw new TypeError("fetch failed"); });
    await expect(client(down as typeof fetch).register(INPUT)).rejects.toThrow(/unreachable/);
  });

  it("refuses non-loopback targets", () => {
    expect(() => new ElegantiaClient({ baseUrl: "http://example.com:17999", timeoutMs: 1 }))
      .toThrow(ConfigError);
  });
});
