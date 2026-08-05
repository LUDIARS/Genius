import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IngestLogEntry } from "../../src/ingest/ingest-contracts.js";
import { JsonlIngestLogger } from "../../src/ingest/jsonl-ingest-logger.js";

function entry(event: IngestLogEntry["event"]): IngestLogEntry {
  return {
    at: "2026-08-04T00:00:00.000Z",
    runId: "run-1",
    source: "memory",
    event,
    filesProcessed: 0,
    cardsCreated: 0,
    cardsMerged: 0,
    skipped: 0,
  };
}

describe("JsonlIngestLogger", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "genius-ingest-logger-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("appends entries as one JSON line each", async () => {
    const path = join(dir, "logs", "ingest.jsonl");
    const logger = new JsonlIngestLogger(path);

    await logger.append(entry("run-started"));
    await logger.append(entry("run-completed"));

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "").event).toBe("run-started");
    expect(JSON.parse(lines[1] ?? "").event).toBe("run-completed");
  });

  it("times out a hung write, warns, and lets later appends proceed (Memoria #735)", async () => {
    const path = join(dir, "ingest.jsonl");
    const warnings: string[] = [];
    const written: string[] = [];
    let calls = 0;
    const logger = new JsonlIngestLogger(path, {
      appendTimeoutMs: 25,
      warningSink: (message) => warnings.push(message),
      writeLine: async (_target, line) => {
        calls += 1;
        if (calls === 1) {
          // 劣化ウィンドウ中の appendFile を模す: 永久に解決しない。
          await new Promise<never>(() => {});
        }
        written.push(line);
      },
    });

    await expect(logger.append(entry("document-started"))).resolves.toBeUndefined();
    expect(warnings.some((line) => line.includes("timed out"))).toBe(true);

    await logger.append(entry("document-completed"));
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0] ?? "").event).toBe("document-completed");
  });

  it("drops a failing write with a warning instead of rejecting", async () => {
    const warnings: string[] = [];
    const logger = new JsonlIngestLogger(join(dir, "ingest.jsonl"), {
      warningSink: (message) => warnings.push(message),
      writeLine: async () => {
        throw new Error("disk detached");
      },
    });

    await expect(logger.append(entry("document-failed"))).resolves.toBeUndefined();
    expect(warnings.some((line) => line.includes("dropped entry (document-failed)"))).toBe(true);
  });
});
