import { describe, expect, it } from "vitest";
import { CardGroupCache } from "../src/cards/card-group-cache.js";
import { cardGroupKey } from "../src/cards/card-group-key.js";
import type { CloneCard } from "../src/domain/card.js";

function card(id: string): CloneCard {
  return {
    id,
    domain: "work",
    visibility: "public",
    category: null,
    situation: `${id} situation`,
    judgment: `${id} judgment`,
    rationale: `${id} rationale`,
    tags: [],
    confidence: 0.9,
    sourceRef: `memory:${id}.md#x`,
    sourceTier: 1,
    decidedBy: null,
    supersededBy: null,
    retiredAt: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("cardGroupKey", () => {
  it("does not collide when a value boundary shifts between fields", () => {
    // 長さ接頭辞が無いと "a|b" と "a"+"|b" のような組が同じキーへ潰れる。
    const left = cardGroupKey({ category: "a|b", tag: undefined });
    const right = cardGroupKey({ category: "a", tag: "b" });

    expect(left).not.toBe(right);
  });

  it("is independent of key order", () => {
    expect(cardGroupKey({ a: 1, b: 2 })).toBe(cardGroupKey({ b: 2, a: 1 }));
  });
});

describe("CardGroupCache", () => {
  it("does not store a group that was only asked for once", () => {
    const cache = new CardGroupCache({ hotThreshold: 2 });

    expect(cache.get("k", "0:1")).toBeNull();
    cache.remember("k", "0:1", [card("one")]);

    expect(cache.get("k", "0:1")).toBeNull();
  });

  it("serves a group once it becomes hot", () => {
    const cache = new CardGroupCache({ hotThreshold: 2 });

    cache.get("k", "0:1");
    cache.remember("k", "0:1", [card("one")]);
    expect(cache.get("k", "0:1")).toBeNull(); // 2 回目の参照でようやく「頻出」になる
    cache.remember("k", "0:1", [card("one")]);

    expect(cache.get("k", "0:1")?.map((entry) => entry.id)).toEqual(["one"]);
  });

  it("misses after the card table is written to", () => {
    const cache = new CardGroupCache({ hotThreshold: 1 });
    cache.get("k", "7:1");
    cache.remember("k", "7:1", [card("one")]);

    // 版が進む = カードが書き換わった。古い並びを返してはいけない。
    expect(cache.get("k", "8:1")).toBeNull();
  });

  it("hands out copies so a caller cannot mutate the stored group", () => {
    const cache = new CardGroupCache({ hotThreshold: 1 });
    cache.get("k", "0:1");
    cache.remember("k", "0:1", [card("one"), card("two")]);

    const first = cache.get("k", "0:1")!;
    first.reverse();

    expect(cache.get("k", "0:1")?.map((entry) => entry.id)).toEqual(["one", "two"]);
  });

  it("drops the least recently used group when full", () => {
    const cache = new CardGroupCache({ hotThreshold: 1, maxEntries: 2 });
    for (const key of ["a", "b"]) {
      cache.get(key, "0:1");
      cache.remember(key, "0:1", [card(key)]);
    }
    cache.get("a", "0:1"); // a を最近使用にする
    cache.get("c", "0:1");
    cache.remember("c", "0:1", [card("c")]);

    expect(cache.get("a", "0:1")).not.toBeNull();
    expect(cache.get("b", "0:1")).toBeNull();
    expect(cache.get("c", "0:1")).not.toBeNull();
  });

  it("bounds one-off request counters with the configured LRU limit", () => {
    const cache = new CardGroupCache({ hotThreshold: 2, maxEntries: 2 });
    for (const key of ["a", "b", "c"]) {
      cache.get(key, "0:1");
      cache.remember(key, "0:1", [card(key)]);
    }

    // a の最初の参照は LRU 上限で忘れているので、再訪 1 回では保存しない。
    cache.get("a", "0:1");
    cache.remember("a", "0:1", [card("a")]);

    expect(cache.get("a", "0:1")).toBeNull();
  });

  it("rejects thresholds that would disable the hot check", () => {
    expect(() => new CardGroupCache({ hotThreshold: 0 })).toThrow(/hotThreshold/);
    expect(() => new CardGroupCache({ maxEntries: 0 })).toThrow(/maxEntries/);
  });
});
