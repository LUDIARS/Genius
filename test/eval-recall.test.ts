import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GeniusQueryService, GeniusQueryResult } from "../src/client/query-contract.js";
import { runEvaluationCli } from "../src/eval/cli.js";
import { loadGoldRecords } from "../src/eval/gold-records.js";
import { evaluateRecallAtK } from "../src/eval/recall.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function makeTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "genius-eval-"));
  temporaryDirectories.push(path);
  return path;
}

function resultForSourceRefs(sourceRefs: readonly string[]): GeniusQueryResult {
  return {
    cards: sourceRefs.map((sourceRef, index) => ({
      id: `card-${index}`,
      domain: "work",
      visibility: "public",
      situation: "situation",
      judgment: "judgment",
      rationale: "rationale",
      tags: [],
      sourceRef,
      sourceTier: 1,
      confidence: 1,
      supersededBy: null,
      createdAt: 1,
      updatedAt: 1,
      score: 1,
    })),
    tookMs: 1,
  };
}

describe("gold JSONL", () => {
  it("loads the canonical query and expectedSourceRefs shape", async () => {
    const directory = await makeTemporaryDirectory();
    const path = join(directory, "gold.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({ query: "first", expectedSourceRefs: ["memory:first"] }),
        JSON.stringify({ query: "second", expectedSourceRefs: ["memory:second", "memory:other"] }),
      ].join("\n"),
      "utf8",
    );

    const loaded = await loadGoldRecords(path);
    expect(loaded).toMatchObject({ kind: "loaded" });
    if (loaded.kind === "loaded") expect(loaded.records).toHaveLength(2);
  });

  it("reports malformed lines with their line number", async () => {
    const directory = await makeTemporaryDirectory();
    const path = join(directory, "gold.jsonl");
    const malformedLines = ['{"query":"ok","expectedSourceRefs":["ref"]}', "not-json", ""];
    await writeFile(path, malformedLines.join("\n"), "utf8");

    await expect(loadGoldRecords(path)).rejects.toThrow(/line 2: invalid JSON/);
  });
});

describe("recall@8", () => {
  it("computes micro recall across expected source references using a single batched embed call", async () => {
    const queryMany = vi.fn(async (inputs: { text: string }[]) =>
      inputs.map((input) =>
        input.text === "first" ? resultForSourceRefs(["a"]) : resultForSourceRefs(["b", "noise"]),
      ),
    );
    const queryService = { queryMany } as unknown as GeniusQueryService;

    const result = await evaluateRecallAtK(
      [
        { query: "first", expectedSourceRefs: ["a"] },
        { query: "second", expectedSourceRefs: ["b", "c"] },
      ],
      queryService,
      8,
    );

    expect(result).toEqual({ k: 8, queries: 2, expected: 3, hits: 2, recall: 2 / 3 });
    expect(queryMany).toHaveBeenCalledTimes(1);
    expect(queryMany.mock.calls[0]?.[0]).toEqual([
      { text: "first", k: 8 },
      { text: "second", k: 8 },
    ]);
  });

  it("prints an explicit Japanese message and exits zero when gold is missing", async () => {
    const directory = await makeTemporaryDirectory();
    const output: string[] = [];
    const queryService = {
      queryMany: vi.fn(async () => {
        throw new Error("must not query when gold is missing");
      }),
    } as unknown as GeniusQueryService;

    const exitCode = await runEvaluationCli([], {
      cwd: directory,
      queryService,
      writeStdout: (text) => output.push(text),
    });

    expect(exitCode).toBe(0);
    expect(output.join("")).toContain("未作成");
    expect(queryService.queryMany).not.toHaveBeenCalled();
  });

  it("fails before querying when an existing gold file is malformed", async () => {
    const directory = await makeTemporaryDirectory();
    const goldPath = join(directory, "gold.jsonl");
    const missingRefsLine = '{"query":"missing expected refs"}';
    await writeFile(goldPath, missingRefsLine + "\n", "utf8");
    const queryService = { queryMany: vi.fn() } as unknown as GeniusQueryService;

    await expect(
      runEvaluationCli(["--gold", goldPath], { cwd: directory, queryService }),
    ).rejects.toThrow(/expectedSourceRefs/);
    expect(queryService.queryMany).not.toHaveBeenCalled();
  });
});
