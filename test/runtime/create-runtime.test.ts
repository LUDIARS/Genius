import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import { createRuntime } from "../../src/runtime/create-runtime.js";

describe("createRuntime embedding model initialization", () => {
  let directory: string | null = null;

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (directory !== null) await rm(directory, { recursive: true, force: true });
  });

  it("does not persist the initial active model when embedding readiness fails", async () => {
    directory = await mkdtemp(join(tmpdir(), "genius-runtime-"));
    const configPath = join(directory, "genius.config.json");
    await writeFile(configPath, JSON.stringify(config()), "utf8");
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/api/tags") {
        return Response.json({ models: [{ name: "bge-m3:latest" }] });
      }
      return new Response("configured runner is unavailable", { status: 500 });
    });

    await expect(createRuntime({ configPath, environment: {} })).rejects.toThrow(
      /Ollama request failed with HTTP 500/,
    );

    const database = openDatabase(join(directory, "data", "genius.db"));
    try {
      const row = database
        .prepare<[], { count: number }>("SELECT count(*) AS count FROM embedding_meta")
        .get();
      expect(row?.count).toBe(0);
    } finally {
      database.close();
    }
  });
});

function config(): Record<string, unknown> {
  return {
    port: 4230,
    dataDir: "./data",
    embedding: {
      baseUrl: "http://127.0.0.1:11434",
      model: "bge-m3",
      dim: 1024,
      numGpu: null,
    },
    distill: {
      backend: "ollama",
      model: "unused",
      sensitiveCheckModel: "unused",
      ollamaModel: "local-distill",
    },
    sources: {
      memoryDir: null,
      sessionLogsDir: null,
      channelArchivesDir: null,
      reviewDir: null,
      claudeProjectsDir: null,
      codexSessionsDir: null,
      memoriaBaseUrl: null,
    },
  };
}
