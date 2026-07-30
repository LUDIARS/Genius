import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ChannelArchiveReader } from "../../src/readers/channel-archive-reader.js";
import { parseFrontmatter } from "../../src/readers/markdown.js";
import { MemoryReader } from "../../src/readers/memory-reader.js";
import { SessionLogReader } from "../../src/readers/session-log-reader.js";
import { SourceReaderError } from "../../src/readers/reader-error.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })),
  );
});

describe("Tier 1 Markdown readers", () => {
  it("parses memory frontmatter separately from the body", async () => {
    const reader = new MemoryReader(fixtureDirectory("memory"));
    const batch = await reader.listDocuments(null);

    expect(batch.documents).toHaveLength(1);
    const descriptor = requiredDescriptor(batch.documents[0]);
    const document = await reader.readDocument(descriptor);
    const frontmatter = document.metadata.frontmatter as Record<string, unknown>;

    expect(document.title).toBe("Prefer explicit failure");
    expect(document.content).toContain("When a required source is missing");
    expect(document.content).not.toContain("confidence: 0.9");
    expect(frontmatter.tags).toEqual(["reliability", "ingestion"]);
    expect(frontmatter.confidence).toBe(0.9);

    const unchanged = await reader.listDocuments(batch.nextCursor);
    expect(unchanged.documents).toEqual([]);
  });

  it("parses one-level nested frontmatter objects (memory's metadata.type block)", async () => {
    const directory = await makeTemporaryDirectory();
    await writeFile(
      join(directory, "nested.md"),
      "---\nname: prefer-explicit-failure\ndescription: fail fast on missing sources\nmetadata:\n  type: feedback\n---\n# Prefer explicit failure\n\nBody text.\n",
      "utf8",
    );
    const reader = new MemoryReader(directory);
    const batch = await reader.listDocuments(null);
    const document = await reader.readDocument(requiredDescriptor(batch.documents[0]));
    const frontmatter = document.metadata.frontmatter as Record<string, unknown>;

    expect(frontmatter.name).toBe("prefer-explicit-failure");
    expect(frontmatter.metadata).toEqual({ type: "feedback" });
  });

  it("rejects nested frontmatter it cannot represent instead of flattening it", () => {
    expect(() => parseFrontmatter("---\nmetadata:\n  a: 1\n    c: 2\n---\nbody\n"))
      .toThrow("nests deeper than one level");
    expect(() => parseFrontmatter("---\nmetadata:\n  b:\n    c: 2\n---\nbody\n"))
      .toThrow("no scalar value");
    expect(() => parseFrontmatter("---\nmetadata:\n  a: 1\n  a: 2\n---\nbody\n"))
      .toThrow("nested key is duplicated");
    expect(() => parseFrontmatter("---\n__proto__: polluted\n---\nbody\n"))
      .toThrow("reserved key");
  });

  it("parses session-log headings without treating fenced Markdown as sections", async () => {
    const reader = new SessionLogReader(fixtureDirectory("session-logs"));
    const batch = await reader.listDocuments(null);
    const document = await reader.readDocument(requiredDescriptor(batch.documents[0]));
    const sections = document.metadata.sections as Array<{ heading: string | null }>;

    expect(document.title).toBe("Session summary");
    expect(sections.map((section) => section.heading)).toEqual([
      "Session summary",
      "Decision",
    ]);
    expect(document.content).toContain("deterministic cursor");
  });

  it("reads channel archives as parsed Markdown documents", async () => {
    const reader = new ChannelArchiveReader(fixtureDirectory("channel-archives"));
    const batch = await reader.listDocuments(null);
    const document = await reader.readDocument(requiredDescriptor(batch.documents[0]));

    expect(document.sourceRef).toBe("channel-archives:archive.md");
    expect(document.title).toBe("Consultation");
    expect(document.metadata.sections).toHaveLength(2);
  });

  it("fails explicitly for unavailable and malformed memory inputs", async () => {
    const missing = new MemoryReader(join(tmpdir(), "genius-reader-does-not-exist"));
    await expect(missing.listDocuments(null)).rejects.toBeInstanceOf(SourceReaderError);

    const directory = await makeTemporaryDirectory();
    await writeFile(join(directory, "broken.md"), "---\ntitle: broken\n# no closing fence\n", "utf8");
    const malformed = new MemoryReader(directory);
    const batch = await malformed.listDocuments(null);
    await expect(
      malformed.readDocument(requiredDescriptor(batch.documents[0])),
    ).rejects.toThrow("malformed");
  });
});

function fixtureDirectory(name: string): string {
  return fileURLToPath(new URL(`../fixtures/readers/${name}/`, import.meta.url));
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "genius-reader-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function requiredDescriptor<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("test fixture did not produce a descriptor");
  }
  return value;
}
