import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import type { ApiServices } from "../../src/api/contracts.js";
import { StaticAssetDirectory } from "../../src/api/ui/static-asset-directory.js";
import { resolveUiRoot } from "../../src/api/ui/ui-root.js";

/** Services that answer reads with empty data; writes must never be reached. */
const services: ApiServices = {
  health: { async get() { return { ok: true, model: "test", cards: 0, ollama: true }; } },
  query: {
    async query() { return { cards: [], tookMs: 0 }; },
    async queryMany(inputs) { return inputs.map(() => ({ cards: [], tookMs: 0 })); },
  },
  cards: {
    async list() { return []; },
    async get() { return null; },
    async create() { throw new Error("create must not run for a rejected request"); },
    async patch() { throw new Error("patch must not run for a rejected request"); },
    async supersedeChain() { return null; },
  },
  categories: {
    async list() { return []; },
    async create() { throw new Error("category create must not run for a rejected request"); },
    async findUnknown() { return []; },
  },
  ingest: {
    start() { throw new Error("ingest must not run for a rejected request"); },
    status() { return null; },
    unresolvedFailures() { return 0; },
  },
  stats: {
    async get() {
      return {
        quadrants: {
          "work:public": 0,
          "work:sensitive": 0,
          "hobby:public": 0,
          "hobby:sensitive": 0,
        },
        tiers: { "1": 0, "2": 0 },
        lastIngestAt: null,
        superseded: 0,
        retired: 0,
        active: 0,
        total: 0,
        unresolvedIngestFailures: 0,
      };
    },
    async exportPublic() { return []; },
  },
};

const CARD_BODY = JSON.stringify({
  domain: "work",
  visibility: "sensitive",
  situation: "A situation",
  judgment: "A judgment",
  rationale: "A rationale",
  tags: [],
  confidence: 0.5,
});

describe("card review UI static serving", () => {
  it("serves the SPA entry point at /ui/ and redirects /ui", async () => {
    const app = createApp(services);

    const index = await app.request("/ui/");
    const html = await index.text();
    const redirect = await app.request("/ui");
    const script = await app.request("/ui/main.js");
    const stylesheet = await app.request("/ui/styles.css");

    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html).toContain('<div id="app"></div>');
    expect(html).toContain('src="./main.js"');
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/ui/");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(stylesheet.status).toBe(200);
    expect(stylesheet.headers.get("content-type")).toBe("text/css; charset=utf-8");
  });

  it("keeps every shipped UI source file plain text", async () => {
    // A raw NUL byte in a source file is legal JavaScript but makes git treat
    // the blob as binary, so the file silently drops out of every diff and out
    // of review. Assert the bytes stay reviewable.
    const root = resolveUiRoot();
    const names = (await readdir(root)).filter((name) => /\.(js|css|html)$/.test(name));

    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const bytes = await readFile(join(root, name));
      expect(`${name}:${bytes.includes(0)}`).toBe(`${name}:false`);
    }
  });

  it("sends no-store and hardening headers with UI assets", async () => {
    const response = await createApp(services).request("/ui/");

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("content-security-policy")).toContain("form-action 'none'");
  });

  it("refuses percent-encoded traversal out of the UI directory over HTTP", async () => {
    const app = createApp(services);

    const encodedParent = await app.request("/ui/%2e%2e%2fpackage.json");
    const encodedSlash = await app.request("/ui/..%2fpackage.json");
    const nestedEncoded = await app.request("/ui/%2e%2e%2f%2e%2e%2fpackage.json");

    expect(encodedParent.status).toBe(404);
    expect(encodedSlash.status).toBe(404);
    expect(nestedEncoded.status).toBe(404);
  });

  it("rejects traversal, absolute paths, and NUL bytes in the asset resolver", async () => {
    const assets = new StaticAssetDirectory(resolveUiRoot());

    await expect(assets.read("../package.json")).resolves.toBeNull();
    await expect(assets.read("a/../../package.json")).resolves.toBeNull();
    await expect(assets.read("a/../")).resolves.toBeNull();
    await expect(assets.read("/etc/hosts")).resolves.toBeNull();
    await expect(assets.read("C:/Windows/win.ini")).resolves.toBeNull();
    await expect(assets.read("main.js\0.css")).resolves.toBeNull();
    await expect(assets.read("sub\\main.js")).resolves.toBeNull();
    await expect(assets.read("index.html")).resolves.not.toBeNull();
  });

  describe("with a temporary UI directory", () => {
    let directory: string;

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), "genius-ui-"));
      await writeFile(join(directory, "index.html"), "<p>page</p>", "utf8");
      await writeFile(join(directory, "notes.txt"), "not servable", "utf8");
      await writeFile(join(directory, "dump.json"), '{"secret":true}', "utf8");
    });

    afterEach(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    it("serves only whitelisted extensions", async () => {
      const app = createApp(services, { uiRoot: directory });

      const page = await app.request("/ui/index.html");
      const text = await app.request("/ui/notes.txt");
      const json = await app.request("/ui/dump.json");
      const missing = await app.request("/ui/absent.js");

      expect(page.status).toBe(200);
      await expect(page.text()).resolves.toBe("<p>page</p>");
      expect(text.status).toBe(404);
      expect(json.status).toBe(404);
      expect(missing.status).toBe(404);
    });
  });
});

describe("browser write protections", () => {
  it("requires application/json on mutating requests", async () => {
    const app = createApp(services);

    const noContentType = await app.request("/api/clone/cards", {
      method: "POST",
      body: CARD_BODY,
    });
    const formEncoded = await app.request("/api/clone/cards", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "domain=work",
    });
    const multipart = await app.request("/api/clone/cards", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body: "--x--",
    });
    const plainText = await app.request("/api/clone/cards/01CARD", {
      method: "PATCH",
      headers: { "content-type": "text/plain" },
      body: CARD_BODY,
    });
    const withCharset = await app.request("/api/clone/cards/01CARD", {
      method: "PATCH",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({}),
    });

    expect(noContentType.status).toBe(415);
    await expect(noContentType.json()).resolves.toEqual({
      error: "Content-Type: application/json is required",
    });
    expect(formEncoded.status).toBe(415);
    expect(multipart.status).toBe(415);
    expect(plainText.status).toBe(415);
    // A JSON media type with parameters passes the guard and reaches schema
    // validation, which rejects the empty patch as bad input rather than 415.
    expect(withCharset.status).toBe(400);
  });

  it("keeps reads working without a content type", async () => {
    const response = await createApp(services).request("/api/clone/cards");

    expect(response.status).toBe(200);
  });

  it("rejects requests carrying a non-loopback Origin", async () => {
    const app = createApp(services);

    const remoteRead = await app.request("/api/clone/cards", {
      headers: { origin: "https://evil.example" },
    });
    const remoteWrite = await app.request("/api/clone/cards", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: CARD_BODY,
    });
    const nullOrigin = await app.request("/api/clone/cards", { headers: { origin: "null" } });
    const lookalikeOrigin = await app.request("/api/clone/cards", {
      headers: { origin: "http://127.0.0.1.evil.example" },
    });
    const uiFromRemote = await app.request("/ui/", {
      headers: { origin: "https://evil.example" },
    });

    expect(remoteRead.status).toBe(403);
    await expect(remoteRead.json()).resolves.toEqual({
      error: "Cross-origin requests are not allowed",
    });
    expect(remoteWrite.status).toBe(403);
    expect(nullOrigin.status).toBe(403);
    expect(lookalikeOrigin.status).toBe(403);
    expect(uiFromRemote.status).toBe(403);
  });

  it("accepts a declared origin and nothing that merely resembles it", async () => {
    const app = createApp(services, { allowedOrigins: ["https://genius.example.com"] });

    const declared = await app.request("/api/clone/cards", {
      headers: { origin: "https://genius.example.com" },
    });
    // 書き込みもガードを通ること。 スタブの実行結果ではなく「拒否されない」
    // ことだけを見る (このテストの責務は origin 判定であって card 作成ではない)。
    const declaredWrite = await app.request("/api/clone/cards", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://genius.example.com",
      },
      body: CARD_BODY,
    });
    const otherScheme = await app.request("/api/clone/cards", {
      headers: { origin: "http://genius.example.com" },
    });
    const subdomain = await app.request("/api/clone/cards", {
      headers: { origin: "https://genius.example.com.evil.example" },
    });
    const undeclared = await app.request("/api/clone/cards", {
      headers: { origin: "https://evil.example" },
    });

    expect(declared.status).toBe(200);
    expect(declaredWrite.status).not.toBe(403);
    expect(otherScheme.status).toBe(403);
    expect(subdomain.status).toBe(403);
    expect(undeclared.status).toBe(403);
  });

  it("accepts loopback origins so the served UI can call the API", async () => {
    const app = createApp(services);

    for (const origin of ["http://127.0.0.1:4230", "http://localhost:4230"]) {
      const response = await app.request("/api/clone/cards", { headers: { origin } });
      expect(response.status).toBe(200);
    }
  });

  it("never emits CORS headers, and offers no preflight", async () => {
    const app = createApp(services);

    const responses = await Promise.all([
      app.request("/healthz"),
      app.request("/ui/"),
      app.request("/api/clone/cards", { headers: { origin: "http://127.0.0.1:4230" } }),
    ]);
    const preflight = await app.request("/api/clone/cards", {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
      },
    });

    for (const response of responses) {
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
      expect(response.headers.get("access-control-allow-headers")).toBeNull();
      expect(response.headers.get("access-control-allow-methods")).toBeNull();
    }
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(preflight.status).toBe(403);
  });
});
