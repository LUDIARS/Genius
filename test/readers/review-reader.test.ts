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

  it("fails when latest.json is malformed", async () => {
    const malformedRoot = await makeTemporaryDirectory();
    await mkdir(join(malformedRoot, "project"), { recursive: true });
    await writeFile(join(malformedRoot, "project", "latest.json"), "not-json", "utf8");
    await expect(new ReviewReader(malformedRoot).listDocuments(null)).rejects.toBeInstanceOf(
      SourceReaderError,
    );
  });

  it("skips projects whose latest directory has no Markdown (daily format_version 2 output)", async () => {
    // 日次差分レビューは review.json だけを書く。throw すると review ソースが
    // 毎 run 失敗する (Memoria #696)。
    const root = await makeTemporaryDirectory();
    await mkdir(join(root, "daily-only", "2026-08-01"), { recursive: true });
    await writeFile(
      join(root, "daily-only", "latest.json"),
      JSON.stringify({ date: "2026-08-01" }),
      "utf8",
    );
    await writeFile(join(root, "daily-only", "2026-08-01", "review.json"), "{}", "utf8");
    await mkdir(join(root, "full", "2026-07-01"), { recursive: true });
    await writeFile(
      join(root, "full", "latest.json"),
      JSON.stringify({ date: "2026-07-01", repo: "LUDIARS/full" }),
      "utf8",
    );
    await writeFile(join(root, "full", "2026-07-01", "REVIEW.md"), "# Full review", "utf8");

    const batch = await new ReviewReader(root).listDocuments(null);
    expect(batch.documents.map((item) => item.locator)).toEqual([
      "full/2026-07-01/REVIEW.md",
    ]);
  });
  it("skips a project whose latest.json points at a pruned date directory", async () => {
    // 日付ディレクトリが整理済みなのは「読むものが無い」であってエラーではない。
    // throw すると 1 プロジェクトの状態で review ソース全体が毎 run 失敗する。
    const root = await makeTemporaryDirectory();
    await mkdir(join(root, "pruned"), { recursive: true });
    await writeFile(
      join(root, "pruned", "latest.json"),
      JSON.stringify({ date: "2026-01-01" }),
      "utf8",
    );
    await mkdir(join(root, "full", "2026-07-01"), { recursive: true });
    await writeFile(
      join(root, "full", "latest.json"),
      JSON.stringify({ date: "2026-07-01" }),
      "utf8",
    );
    await writeFile(join(root, "full", "2026-07-01", "REVIEW.md"), "# Full review", "utf8");

    const batch = await new ReviewReader(root).listDocuments(null);
    expect(batch.documents.map((item) => item.locator)).toEqual([
      "full/2026-07-01/REVIEW.md",
    ]);
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
