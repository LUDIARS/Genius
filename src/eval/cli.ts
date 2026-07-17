import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGeniusHttpClientFromEnvironment } from "../client/genius-http-client.js";
import type { Environment } from "../client/base-url.js";
import type { GeniusQueryService } from "../client/query-contract.js";
import { loadGoldRecords } from "./gold-records.js";
import { evaluateRecallAtK } from "./recall.js";

export interface EvaluationCliDependencies {
  cwd?: string;
  env?: Environment;
  queryService?: GeniusQueryService;
  writeStdout?: (text: string) => void;
}

export async function runEvaluationCli(
  args: readonly string[],
  dependencies: EvaluationCliDependencies = {},
): Promise<number> {
  const parsed = parseArgs({
    args: [...args],
    options: {
      gold: { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });
  const cwd = dependencies.cwd ?? process.cwd();
  const goldPath = resolve(cwd, parsed.values.gold ?? "eval/gold.jsonl");
  const gold = await loadGoldRecords(goldPath);
  const writeStdout = dependencies.writeStdout ?? ((text: string) => process.stdout.write(text));

  if (gold.kind === "missing") {
    writeStdout(`ゴールド評価データは未作成です: ${goldPath}\n`);
    return 0;
  }

  const queryService =
    dependencies.queryService ?? createGeniusHttpClientFromEnvironment(dependencies.env);
  const result = await evaluateRecallAtK(gold.records, queryService, 8);
  writeStdout(
    `recall@${result.k}: ${result.recall.toFixed(4)} ` +
      `(${result.hits}/${result.expected}, queries=${result.queries})\n`,
  );
  return 0;
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry);
}

if (isEntrypoint()) {
  try {
    process.exitCode = await runEvaluationCli(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Genius evaluation failed: ${message}\n`);
    process.exitCode = 1;
  }
}
