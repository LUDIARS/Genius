#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { GeniusHttpClient } from "./client/genius-http-client.js";
import { resolveGeniusBaseUrl } from "./client/base-url.js";
import { CardRepository } from "./cards/card-repository.js";
import { loadConfig, type LoadConfigOptions } from "./config/load-config.js";
import { domainSchema, visibilitySchema } from "./domain/card.js";
import { openConfiguredDatabase } from "./db/database.js";
import { runMigrations } from "./db/migrate.js";
import { EmbeddingCache } from "./embedding/cache.js";
import { EmbeddingModelRegistry } from "./embedding/model-registry.js";
import { OllamaEmbeddingClient } from "./embedding/ollama-client.js";
import { ReembedService } from "./embedding/reembed.js";
import { VectorStore } from "./embedding/vector-store.js";
import { sourceNameSchema, type SourceName } from "./readers/source-reader.js";

const ingestStartSchema = z.object({ id: z.string().min(1), status: z.literal("running") });

export interface CliDependencies extends LoadConfigOptions {
  fetch?: typeof globalThis.fetch;
  stderr?: (text: string) => void;
  stdout?: (text: string) => void;
}

export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? ((text: string) => process.stdout.write(text));
  const command = argv[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    stdout(usage());
    return command ? 0 : 1;
  }

  const config = loadConfig(dependencies);
  const baseUrl = resolveGeniusBaseUrl(dependencies.environment ?? process.env, config.port);
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  switch (command) {
    case "query":
      return runQuery(argv.slice(1), baseUrl, fetchImplementation, stdout);
    case "ingest":
      return runIngest(argv.slice(1), baseUrl, fetchImplementation, stdout);
    case "stats":
      return runStats(argv.slice(1), baseUrl, fetchImplementation, stdout);
    case "reembed":
      return runReembed(argv.slice(1), config, fetchImplementation, stdout);
    default:
      throw new Error(`Unknown command: ${command}\n${usage()}`);
  }
}

async function runQuery(
  args: readonly string[],
  baseUrl: string,
  fetchImplementation: typeof globalThis.fetch,
  stdout: (text: string) => void,
): Promise<number> {
  const parsed = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      domain: { type: "string" },
      visibility: { type: "string" },
      k: { type: "string", short: "k", default: "8" },
    },
  });
  if (parsed.positionals.length !== 1) throw new Error("query requires exactly one text argument");
  const k = positiveInteger(parsed.values.k, "k", 100);
  const client = new GeniusHttpClient({ baseUrl, fetch: fetchImplementation });
  const result = await client.query({
    text: parsed.positionals[0]!,
    ...(parsed.values.domain === undefined ? {} : { domain: domainSchema.parse(parsed.values.domain) }),
    ...(parsed.values.visibility === undefined
      ? {}
      : { visibility: visibilitySchema.parse(parsed.values.visibility) }),
    k,
  });
  stdout(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

async function runIngest(
  args: readonly string[],
  baseUrl: string,
  fetchImplementation: typeof globalThis.fetch,
  stdout: (text: string) => void,
): Promise<number> {
  const parsed = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      sources: { type: "string" },
      tier2: { type: "boolean", default: false },
      "budget-files": { type: "string" },
      "allow-missing": { type: "boolean", default: false },
      "retry-failed": { type: "boolean", default: false },
    },
  });
  if (parsed.values["retry-failed"] && parsed.values["budget-files"] !== undefined) {
    throw new Error("--retry-failed does not accept --budget-files");
  }
  if (
    parsed.values.tier2
    && !parsed.values["retry-failed"]
    && parsed.values["budget-files"] === undefined
  ) {
    throw new Error("--tier2 requires --budget-files N");
  }
  const budgetFiles = parsed.values["budget-files"] === undefined
    ? undefined
    : positiveInteger(parsed.values["budget-files"], "budget-files");
  const sources = parsed.values.sources === undefined
    ? undefined
    : parseSources(parsed.values.sources);
  const response = await requestJson(
    new URL("/api/clone/ingest/run", baseUrl),
    fetchImplementation,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(sources === undefined ? {} : { sources }),
        tier2: parsed.values.tier2,
        ...(budgetFiles === undefined ? {} : { budgetFiles }),
        allowMissing: parsed.values["allow-missing"],
        retryFailed: parsed.values["retry-failed"],
      }),
    },
  );
  stdout(`${JSON.stringify(ingestStartSchema.parse(response), null, 2)}\n`);
  return 0;
}

async function runStats(
  args: readonly string[],
  baseUrl: string,
  fetchImplementation: typeof globalThis.fetch,
  stdout: (text: string) => void,
): Promise<number> {
  if (args.length !== 0) throw new Error("stats does not accept arguments");
  const stats = await requestJson(
    new URL("/api/clone/stats", baseUrl),
    fetchImplementation,
    { method: "GET" },
  );
  stdout(`${JSON.stringify(stats, null, 2)}\n`);
  return 0;
}

async function runReembed(
  args: readonly string[],
  config: ReturnType<typeof loadConfig>,
  fetchImplementation: typeof globalThis.fetch,
  stdout: (text: string) => void,
): Promise<number> {
  const parsed = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: { model: { type: "string" } },
  });
  const model = parsed.values.model?.trim();
  if (!model) throw new Error("reembed requires --model <name>");
  const database = openConfiguredDatabase(config);
  try {
    runMigrations(database);
    const client = new OllamaEmbeddingClient({
      baseUrl: config.embedding.baseUrl,
      model,
      dimension: config.embedding.dim,
      fetch: fetchImplementation,
      ...(config.embedding.numGpu === null ? {} : { numGpu: config.embedding.numGpu }),
      ...(config.embedding.keepAlive === null ? {} : { keepAlive: config.embedding.keepAlive }),
    });
    const result = await new ReembedService(
      database,
      new CardRepository(database),
      new EmbeddingCache(database),
      client,
      new EmbeddingModelRegistry(database),
      new VectorStore(database, config.embedding.dim),
    ).run();
    stdout(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } finally {
    database.close();
  }
}

async function requestJson(
  url: URL,
  fetchImplementation: typeof globalThis.fetch,
  init: RequestInit,
): Promise<unknown> {
  const response = await fetchImplementation(url, { ...init, redirect: "error" });
  if (!response.ok) {
    throw new Error(`Genius API request failed with HTTP ${response.status}`);
  }
  const body = await response.text();
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new Error("Genius API returned invalid JSON", { cause: error });
  }
}

function parseSources(raw: string): SourceName[] {
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) throw new Error("--sources must contain at least one source");
  return [...new Set(values.map((value) => sourceNameSchema.parse(value)))];
}

function positiveInteger(raw: string | undefined, name: string, maximum?: number): number {
  if (raw === undefined || !/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || (maximum !== undefined && value > maximum)) {
    throw new Error(
      maximum === undefined
        ? `${name} must be a positive integer`
        : `${name} must be an integer from 1 through ${maximum}`,
    );
  }
  return value;
}

function usage(): string {
  return [
    "Usage:",
    '  genius query "<text>" [--domain work|hobby] [--visibility public|sensitive] [-k 8]',
    "  genius ingest [--sources memory,review] [--tier2 --budget-files 500] [--allow-missing] [--retry-failed]",
    "  genius stats",
    "  genius reembed --model <name>",
    "",
  ].join("\n");
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry);
}

if (isEntrypoint()) {
  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`Genius CLI failed: ${detail}\n`);
    process.exitCode = 1;
  }
}
