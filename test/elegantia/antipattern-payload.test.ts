import { describe, expect, it } from "vitest";
import type { CloneCard } from "../../src/domain/card.js";
import { toElegantiaAntipattern } from "../../src/elegantia/antipattern-payload.js";
import { qualityRouteEligible } from "../../src/elegantia/quality-route-eligibility.js";

function card(overrides: Partial<CloneCard> = {}): CloneCard {
  return {
    id: "01CARD",
    domain: "work",
    visibility: "public",
    category: null,
    situation: "An API handler calls another service synchronously on every request",
    judgment: "Cache or pre-resolve upstream data; never block a request on it\nsecond line",
    rationale: "Responses over one second are defects",
    tags: ["latency"],
    confidence: 0.9,
    sourceRef: "memory:private/notes.md#card-sha256-abc",
    sourceTier: 1,
    decidedBy: null,
    supersededBy: null,
    retiredAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("toElegantiaAntipattern", () => {
  it("anchors on the card id and never carries the ingest sourceRef", () => {
    const payload = toElegantiaAntipattern(card());
    expect(payload).toEqual({
      sourceRef: "genius:card:01CARD",
      title: "Cache or pre-resolve upstream data; never block a request on it",
      summary: "Responses over one second are defects",
      detect: ["An API handler calls another service synchronously on every request"],
      fix: "Cache or pre-resolve upstream data; never block a request on it\nsecond line",
      tags: ["latency"],
      augur: null,
    });
    expect(JSON.stringify(payload)).not.toContain("private/notes.md");
  });

  it("truncates long titles", () => {
    const payload = toElegantiaAntipattern(card({ judgment: "x".repeat(300) }));
    expect([...payload.title]).toHaveLength(120);
    expect(payload.title.endsWith("…")).toBe(true);
  });
});

describe("qualityRouteEligible", () => {
  it("accepts only public, active cards", () => {
    expect(qualityRouteEligible(card())).toBe(true);
    expect(qualityRouteEligible(card({ visibility: "sensitive" }))).toBe(false);
    expect(qualityRouteEligible(card({ supersededBy: "01NEXT" }))).toBe(false);
    expect(qualityRouteEligible(card({ retiredAt: 5 }))).toBe(false);
  });
});
