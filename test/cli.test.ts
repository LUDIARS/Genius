import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";

describe("Genius CLI", () => {
  let directory: string;
  let configPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "genius-cli-"));
    configPath = join(directory, "genius.config.json");
    await writeFile(configPath, JSON.stringify({
      port: 4321,
      dataDir: "./data",
      embedding: {
        baseUrl: "http://127.0.0.1:11434",
        model: "bge-m3",
        dim: 1024,
        numGpu: 0,
      },
      distill: {
        backend: "claude-cli",
        model: "test-model",
        sensitiveCheckModel: "test-model",
        ollamaModel: "test-local-model",
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
    }), "utf8");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("routes query, ingest, and stats through the configured loopback API", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null;
      requests.push({ path: url.pathname, body });
      if (url.pathname.endsWith("/query")) {
        return Response.json({ cards: [], tookMs: 1 });
      }
      if (url.pathname.endsWith("/ingest/run")) {
        return Response.json({ id: "run-1", status: "running" }, { status: 202 });
      }
      if (url.pathname.endsWith("/stats")) {
        return Response.json({ total: 0 });
      }
      return Response.json({ error: "unexpected request" }, { status: 404 });
    });
    const output: string[] = [];
    const dependencies = {
      configPath,
      environment: {},
      fetch: fetchMock as typeof fetch,
      stdout: (text: string) => output.push(text),
    };

    await expect(runCli(["query", "reversible choice", "--domain", "work"], dependencies))
      .resolves.toBe(0);
    await expect(runCli(["ingest", "--sources", "memory", "--allow-missing"], dependencies))
      .resolves.toBe(0);
    await expect(runCli(["stats"], dependencies)).resolves.toBe(0);

    expect(requests).toEqual([
      {
        path: "/api/clone/query",
        body: { text: "reversible choice", domain: "work", k: 8 },
      },
      {
        path: "/api/clone/ingest/run",
        body: {
          sources: ["memory"],
          tier2: false,
          allowMissing: true,
        },
      },
      { path: "/api/clone/stats", body: null },
    ]);
    expect(output.join("\n")).toContain('"run-1"');
  });

  it("runs reembed against the explicitly configured local Ollama path", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/tags")) {
        return Response.json({ models: [{ name: "bge-m3:latest" }] });
      }
      const body = JSON.parse(String(init?.body)) as { input: string[]; options?: unknown };
      expect(body.options).toEqual({ num_gpu: 0 });
      return Response.json({
        model: "bge-m3",
        embeddings: body.input.map(() => [1, ...new Array<number>(1023).fill(0)]),
      });
    });
    const output: string[] = [];

    await expect(runCli(["reembed", "--model", "bge-m3"], {
      configPath,
      environment: {},
      fetch: fetchMock as typeof fetch,
      stdout: (text) => output.push(text),
    })).resolves.toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(output.join("")).toContain('"cardsReembedded": 0');
  });
});
