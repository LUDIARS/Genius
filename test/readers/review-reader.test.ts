import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ReviewReader } from "../../src/readers/review-reader.js";
import { SourceReaderError } from "../../src/readers/reader-error.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })),
  );
});

describe("ReviewReader", () => {
  it("uses each project latest.json to select its current Markdown artifacts", async () => {
    const reader = new ReviewReader(fixtureDirectory());
    const batch = await reader.listDocuments(null);

    expect(batch.documents.map((item) => item.locator)).toEqual([
      "project-a/2026-07-01/REVIEW.md",
    ]);
    const descriptor = batch.documents[0];
    if (descriptor === undefined) {
      throw new Error("review fixture did not produce a descriptor");
    }
    const document = await reader.readDocument(descriptor);

    expect(document.title).toBe("Project A review");
    expect(document.content).toContain('"weighted_score": "B"');
    expect(document.content).toContain("bounded asynchronous traversal");
    expect(document.content).not.toContain("historical report");
  });

  it("fails when latest.json is malformed or its selected directory has no Markdown", async () => {
    const malformedRoot = await makeTemporaryDirectory();
    await mkdir(join(malformedRoot, "project"), { recursive: true });
    await writeFile(join(malformedRoot, "project", "latest.json"), "not-json", "utf8");
    await expect(new ReviewReader(malformedRoot).listDocuments(null)).rejects.toBeInstanceOf(
      SourceReaderError,
    );

    const emptyRoot = await makeTemporaryDirectory();
    await mkdir(join(emptyRoot, "project", "2026-07-01"), { recursive: true });
    await writeFile(
      join(emptyRoot, "project", "latest.json"),
      JSON.stringify({ date: "2026-07-01" }),
      "utf8",
    );
    await expect(new ReviewReader(emptyRoot).listDocuments(null)).rejects.toThrow(
      "no Markdown documents",
    );
  });
});

function fixtureDirectory(): string {
  return fileURLToPath(new URL("../fixtures/readers/review/", import.meta.url));
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "genius-review-reader-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
