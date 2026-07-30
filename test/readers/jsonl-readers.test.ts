import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ClaudeJsonlReader } from "../../src/readers/claude-jsonl-reader.js";
import { CodexJsonlReader } from "../../src/readers/codex-jsonl-reader.js";
import type {
  ReaderCursor,
  SourceDocumentContent,
  SourceDocumentDescriptor,
} from "../../src/readers/source-reader.js";

const temporaryDirectories: string[] = [];
const MTIME_BASE = 1_700_000_000_000;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })),
  );
});

describe("Tier 2 JSONL readers", () => {
  it("streams Claude transcripts lazily and can replay them for retries", async () => {
    const reader = new ClaudeJsonlReader(fixtureDirectory("claude"));
    const batch = await reader.listDocuments(null, { budgetFiles: 1 });
    const document = await reader.readDocument(requiredDescriptor(batch.documents[0]));

    expect(typeof document.content).not.toBe("string");
    const firstPass = await collectStreamingContent(document.content);
    const retryPass = await collectStreamingContent(document.content);

    expect(firstPass).toBe(retryPass);
    expect(firstPass).toContain("[system]\nFollow the repository rules.");
    expect(firstPass).toContain("[user]\nHow should missing input be handled?");
    expect(firstPass).toContain("[assistant]\nFail explicitly");
  });

  it("streams Codex response_item messages", async () => {
    const reader = new CodexJsonlReader(fixtureDirectory("codex"));
    const batch = await reader.listDocuments(null, { budgetFiles: 1 });
    const document = await reader.readDocument(requiredDescriptor(batch.documents[0]));
    const content = await collectStreamingContent(document.content);

    expect(content).toContain("[user]\nChoose a traversal strategy.");
    expect(content).toContain("[assistant]\nUse asynchronous bounded traversal.");
    expect(content).not.toContain("session_meta");
  });

  it("reports malformed JSON with its line number while streaming", async () => {
    const reader = new ClaudeJsonlReader(fixtureDirectory("malformed-jsonl"));
    const batch = await reader.listDocuments(null, { budgetFiles: 1 });
    const document = await reader.readDocument(requiredDescriptor(batch.documents[0]));

    await expect(collectStreamingContent(document.content)).rejects.toThrow("line 2");
  });

  it("enforces budget and drains new catch-up plus old backfill without losing files", async () => {
    const { directory, reader } = await makeSeededReader(1, 2, 3, 4, 5);

    const first = await reader.listDocuments(null, { budgetFiles: 2 });
    expectLocators(first.documents, ["session-5.jsonl", "session-4.jsonl"]);
    const firstCursor = requiredCursor(first.nextCursor);

    const second = await reader.listDocuments(firstCursor, { budgetFiles: 2 });
    expectLocators(second.documents, ["session-3.jsonl", "session-2.jsonl"]);
    const secondCursor = requiredCursor(second.nextCursor);

    await seedSyntheticSessions(directory, [7, 6]);

    const newHead = await reader.listDocuments(secondCursor, { budgetFiles: 1 });
    expectLocators(newHead.documents, ["session-7.jsonl"]);
    expect(newHead.nextCursor?.catchUp).toBeDefined();

    // Arrival during an active catch-up is deferred to the next wave, not lost
    // or appended out of mtime order behind the older pending file.
    await seedSyntheticSessions(directory, [8]);

    const newTail = await reader.listDocuments(requiredCursor(newHead.nextCursor), {
      budgetFiles: 1,
    });
    expectLocators(newTail.documents, ["session-6.jsonl"]);
    expect(newTail.nextCursor?.catchUp).toBeUndefined();

    const nextArrival = await reader.listDocuments(requiredCursor(newTail.nextCursor), {
      budgetFiles: 1,
    });
    expectLocators(nextArrival.documents, ["session-8.jsonl"]);

    const finalBackfill = await reader.listDocuments(requiredCursor(nextArrival.nextCursor), {
      budgetFiles: 2,
    });
    expectLocators(finalBackfill.documents, ["session-1.jsonl"]);

    const complete = await reader.listDocuments(requiredCursor(finalBackfill.nextCursor), {
      budgetFiles: 2,
    });
    expect(complete.documents).toEqual([]);
  });

  it("uses locator as a deterministic tie-break and rejects a non-positive budget", async () => {
    const directory = await makeTemporaryDirectory();
    await writeSyntheticSession(directory, 1, MTIME_BASE);
    await writeSyntheticSession(directory, 2, MTIME_BASE);
    const reader = new ClaudeJsonlReader(directory);

    const batch = await reader.listDocuments(null, { budgetFiles: 1 });
    expectLocators(batch.documents, ["session-2.jsonl"]);
    await expect(reader.listDocuments(null, { budgetFiles: 0 })).rejects.toThrow(
      "positive integer",
    );
  });

  it("processes every unread file in one batch when no budget is given", async () => {
    // Unbounded Tier 2 path (spec/feature/operations.md section 6): a missing
    // budget is "no cap", not an error and not a hidden default.
    const { directory, reader } = await makeSeededReader(1, 2, 3, 4, 5);

    const initial = await reader.listDocuments(null);
    expectLocators(initial.documents, [
      "session-5.jsonl",
      "session-4.jsonl",
      "session-3.jsonl",
      "session-2.jsonl",
      "session-1.jsonl",
    ]);

    // Incremental run after new arrivals also drains everything at once.
    await seedSyntheticSessions(directory, [7, 6]);
    const incremental = await reader.listDocuments(requiredCursor(initial.nextCursor));
    expectLocators(incremental.documents, ["session-7.jsonl", "session-6.jsonl"]);

    const drained = await reader.listDocuments(requiredCursor(incremental.nextCursor));
    expect(drained.documents).toEqual([]);
  });

  it("drains a catch-up left by an earlier budgeted run before going unbounded", async () => {
    // Upgrade path for deployments that already ran with `--budget-files N`:
    // their persisted cursor can carry a pending `catchUp` range. An unbounded
    // run must finish that range first (batches stay strictly mtime-descending),
    // then drain the remaining backlog — no file is skipped or replayed.
    const { directory, reader } = await makeSeededReader(1, 2, 3, 4, 5);

    const budgeted = await reader.listDocuments(null, { budgetFiles: 2 });
    expectLocators(budgeted.documents, ["session-5.jsonl", "session-4.jsonl"]);

    await seedSyntheticSessions(directory, [7, 6]);
    const partial = await reader.listDocuments(requiredCursor(budgeted.nextCursor), {
      budgetFiles: 1,
    });
    expectLocators(partial.documents, ["session-7.jsonl"]);
    expect(partial.nextCursor?.catchUp).toBeDefined();

    const catchUp = await reader.listDocuments(requiredCursor(partial.nextCursor));
    expectLocators(catchUp.documents, ["session-6.jsonl"]);
    expect(catchUp.nextCursor?.catchUp).toBeUndefined();

    const backfill = await reader.listDocuments(requiredCursor(catchUp.nextCursor));
    expectLocators(backfill.documents, [
      "session-3.jsonl",
      "session-2.jsonl",
      "session-1.jsonl",
    ]);

    const complete = await reader.listDocuments(requiredCursor(backfill.nextCursor));
    expect(complete.documents).toEqual([]);
  });
});

function fixtureDirectory(name: string): string {
  return fileURLToPath(new URL(`../fixtures/readers/${name}/`, import.meta.url));
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "genius-jsonl-reader-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function makeSeededReader(
  ...indices: readonly number[]
): Promise<{ directory: string; reader: ClaudeJsonlReader }> {
  const directory = await makeTemporaryDirectory();
  await seedSyntheticSessions(directory, indices);
  return { directory, reader: new ClaudeJsonlReader(directory) };
}

async function seedSyntheticSessions(
  directory: string,
  indices: readonly number[],
): Promise<void> {
  for (const index of indices) {
    await writeSyntheticSession(directory, index, MTIME_BASE + index * 1_000);
  }
}

async function writeSyntheticSession(
  directory: string,
  index: number,
  mtimeMs: number,
): Promise<void> {
  const path = join(directory, `session-${index}.jsonl`);
  await writeFile(
    path,
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: `synthetic message ${index}` },
    })}\n`,
    "utf8",
  );
  const timestamp = new Date(mtimeMs);
  await utimes(path, timestamp, timestamp);
}

async function collectStreamingContent(content: SourceDocumentContent): Promise<string> {
  if (typeof content === "string") {
    throw new Error("Tier 2 content unexpectedly materialized to a string");
  }
  let result = "";
  for await (const chunk of content) {
    result += chunk;
  }
  return result;
}

function expectLocators(
  descriptors: readonly SourceDocumentDescriptor[],
  expected: readonly string[],
): void {
  expect(descriptors.map((descriptor) => descriptor.locator)).toEqual(expected);
}

function requiredDescriptor(
  value: SourceDocumentDescriptor | undefined,
): SourceDocumentDescriptor {
  if (value === undefined) {
    throw new Error("test fixture did not produce a descriptor");
  }
  return value;
}

function requiredCursor(value: ReaderCursor | null): ReaderCursor {
  if (value === null) {
    throw new Error("test batch did not produce a cursor");
  }
  return value;
}
