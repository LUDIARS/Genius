import { describe, expect, it } from "vitest";
import { createApp, MAX_API_BODY_BYTES } from "../../src/api/app.js";
import type { ApiServices } from "../../src/api/contracts.js";
import {
  distilledCardSchema,
  MAX_CARD_TAG_COUNT,
  MAX_CARD_TAG_LENGTH,
  MAX_CARD_TEXT_LENGTH,
} from "../../src/domain/card.js";

const services: ApiServices = {
  health: { async get() { return { ok: true, model: "test", cards: 0, ollama: true }; } },
  query: {
    async query() { return { cards: [], tookMs: 0 }; },
    async queryMany(inputs) { return inputs.map(() => ({ cards: [], tookMs: 0 })); },
  },
  cards: {
    async list() { return []; },
    async get() { return null; },
    async create() { throw new Error("create must not run for rejected input"); },
    async patch() { throw new Error("patch must not run for rejected input"); },
    async supersedeChain() { return null; },
  },
  categories: {
    async list() { return []; },
    async create() { throw new Error("category create must not run for rejected input"); },
    async findUnknown() { return []; },
  },
  ingest: {
    start() { throw new Error("ingest must not run for rejected input"); },
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

function card(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    domain: "work",
    visibility: "public",
    situation: "A bounded situation",
    judgment: "Choose a bounded action",
    rationale: "It limits resource use",
    tags: ["security"],
    confidence: 0.9,
    ...overrides,
  };
}

describe("card and HTTP resource limits", () => {
  it("enforces global card field, tag-length, and tag-count bounds", () => {
    expect(() => distilledCardSchema.parse(card({
      situation: "x".repeat(MAX_CARD_TEXT_LENGTH + 1),
    }))).toThrow();
    expect(() => distilledCardSchema.parse(card({
      tags: ["x".repeat(MAX_CARD_TAG_LENGTH + 1)],
    }))).toThrow();
    expect(() => distilledCardSchema.parse(card({
      tags: Array.from({ length: MAX_CARD_TAG_COUNT + 1 }, () => "tag"),
    }))).toThrow();
  });

  it("rejects request bodies before JSON parsing when they exceed the global limit", async () => {
    const response = await createApp(services).request("/api/clone/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(MAX_API_BODY_BYTES) }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Request body is too large" });
  });

  it("returns 400 for an oversized card field within the HTTP body limit", async () => {
    const response = await createApp(services).request("/api/clone/cards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(card({ judgment: "x".repeat(MAX_CARD_TEXT_LENGTH + 1) })),
    });

    expect(response.status).toBe(400);
  });
});
