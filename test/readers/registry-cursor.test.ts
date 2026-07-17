import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  parseReaderCursor,
  serializeReaderCursor,
} from "../../src/readers/cursor.js";
import {
  createReaderRegistry,
  createSourceReader,
} from "../../src/readers/registry.js";
import { sourceNameSchema } from "../../src/readers/source-reader.js";

describe("reader registry and cursors", () => {
  it("constructs all seven readers only from explicit factory inputs", () => {
    const directory = fileURLToPath(new URL("../fixtures/readers/", import.meta.url));
    const registry = createReaderRegistry({
      memoryDir: directory,
      sessionLogsDir: directory,
      channelArchivesDir: directory,
      reviewDir: directory,
      memoriaBaseUrl: "http://127.0.0.1:5180",
      claudeProjectsDir: directory,
      codexSessionsDir: directory,
      fetchImplementation: async () => new Response(JSON.stringify({ items: [] })),
    });

    expect([...registry.keys()]).toEqual([
      "memory",
      "session-logs",
      "channel-archives",
      "review",
      "memoria",
      "claude-jsonl",
      "codex-jsonl",
    ]);
    expect(() => createSourceReader("memory", {})).toThrow("not configured");
    expect(sourceNameSchema.parse("claude-jsonl")).toBe("claude-jsonl");
  });

  it("round-trips extended Tier 2 cursor state and accepts legacy position JSON", () => {
    const cursor = {
      mtimeMs: 300,
      locator: "recent.jsonl",
      backfill: { mtimeMs: 100, locator: "old.jsonl" },
      catchUp: {
        target: { mtimeMs: 500, locator: "newest.jsonl" },
        before: { mtimeMs: 400, locator: "newer.jsonl" },
      },
    } as const;

    expect(parseReaderCursor("claude-jsonl", serializeReaderCursor(cursor))).toEqual(cursor);
    expect(
      parseReaderCursor(
        "claude-jsonl",
        JSON.stringify({ mtimeMs: 300, locator: "legacy.jsonl" }),
      ),
    ).toEqual({ mtimeMs: 300, locator: "legacy.jsonl" });
    expect(() => parseReaderCursor("claude-jsonl", "not-json")).toThrow("not valid JSON");
  });
});
