import type { Hono } from "hono";
import type { StaticAssetDirectory } from "../ui/static-asset-directory.js";

/**
 * Headers sent with every UI asset. The CSP keeps the page limited to its own
 * origin (no CDN, no inline script) and forbids form submission, which is the
 * browser path that could bypass the JSON content-type requirement.
 */
const UI_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const UI_PREFIX = "/ui/";

export function registerUiRoutes(app: Hono, assets: StaticAssetDirectory): void {
  app.get("/ui", (c) => c.redirect(UI_PREFIX, 302));

  app.get("/ui/*", async (c) => {
    const asset = await assets.read(c.req.path.slice(UI_PREFIX.length));
    if (asset === null) return c.json({ error: "Not found" }, 404);
    return new Response(asset.body, {
      status: 200,
      headers: { "content-type": asset.contentType, ...UI_RESPONSE_HEADERS },
    });
  });
}
