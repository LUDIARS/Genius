import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const HOOK_CARD = {
  id: "card-1",
  domain: "work",
  visibility: "public",
  situation: "A decision is needed",
  judgment: "Prefer reversible steps",
  rationale: "It preserves information",
  tags: ["design"],
  sourceRef: "memory:private-project/decision.md",
  sourceTier: 1,
  confidence: 0.9,
  supersededBy: null,
  createdAt: 1,
  updatedAt: 1,
  score: 0.87,
};

let httpServer: Server | undefined;

afterEach(async () => {
  const server = httpServer;
  httpServer = undefined;
  if (server) await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP address");
  return address.port;
}

async function runAdapter(
  stdin: string,
  env: Record<string, string | undefined>,
): Promise<ChildResult> {
  const child = spawn(
    process.execPath,
    [resolve(process.cwd(), "hooks/genius-harness-supply.mjs")],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  let stdinError: Error | undefined;
  child.stdin.once("error", (error) => (stdinError = error));
  child.stdin.end(stdin, "utf8");

  return await new Promise<ChildResult>((resolveChild, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0 && stdinError) reject(stdinError);
      else resolveChild({ code, stdout, stderr });
    });
  });
}

describe("genius-harness-supply adapter", () => {
  it("is a no-op when the harness switch is disabled (default)", async () => {
    const result = await runAdapter(
      JSON.stringify({ prompt: "How should I decide this?", cwd: process.cwd() }),
      { GENIUS_BASE_URL: "http://127.0.0.1:9" },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("supplies cards from the Claude Code UserPromptSubmit JSON payload when enabled", async () => {
    let requestBody: unknown;
    httpServer = createServer(async (request, response) => {
      let body = "";
      request.setEncoding("utf8");
      for await (const chunk of request) body += chunk;
      requestBody = JSON.parse(body) as unknown;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ cards: [HOOK_CARD], tookMs: 2 }));
    });
    const port = await listen(httpServer);

    const result = await runAdapter(
      JSON.stringify({ prompt: "  Help me decide  \n", cwd: process.cwd(), session_id: "s1" }),
      { GENIUS_HARNESS_HOOKS: "1", GENIUS_BASE_URL: `http://127.0.0.1:${port}` },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^\[genius-supply\]/);
    expect(result.stdout).toContain('"judgment": "Prefer reversible steps"');
    expect(result.stdout).not.toContain("private-project");
    expect(requestBody).toEqual({ text: "Help me decide", visibility: "public" });
  });

  it("fails open (silent exit 0) when Genius is unreachable", async () => {
    const result = await runAdapter(JSON.stringify({ prompt: "decide something", cwd: "." }), {
      GENIUS_HARNESS_HOOKS: "1",
      GENIUS_BASE_URL: "http://127.0.0.1:9",
      GENIUS_HARNESS_TIMEOUT_MS: "300",
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("fails open when stdin is not the expected JSON payload", async () => {
    const result = await runAdapter("not json at all", {
      GENIUS_HARNESS_HOOKS: "1",
      GENIUS_BASE_URL: "http://127.0.0.1:9",
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("fails open and skips the network call entirely when the prompt is empty", async () => {
    const result = await runAdapter(JSON.stringify({ prompt: "   ", cwd: "." }), {
      GENIUS_HARNESS_HOOKS: "1",
      GENIUS_BASE_URL: "http://127.0.0.1:9",
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("fails open without leaking card content when the response contains a non-public card", async () => {
    httpServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ cards: [{ ...HOOK_CARD, visibility: "sensitive" }], tookMs: 2 }),
      );
    });
    const port = await listen(httpServer);

    const result = await runAdapter(JSON.stringify({ prompt: "decide something", cwd: "." }), {
      GENIUS_HARNESS_HOOKS: "1",
      GENIUS_BASE_URL: `http://127.0.0.1:${port}`,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stdout).not.toContain("Prefer reversible steps");
  });

  it("emits debug diagnostics on stderr only when GENIUS_HARNESS_DEBUG=1", async () => {
    const result = await runAdapter(JSON.stringify({ prompt: "decide something", cwd: "." }), {
      GENIUS_HARNESS_HOOKS: "1",
      GENIUS_BASE_URL: "http://127.0.0.1:9",
      GENIUS_HARNESS_TIMEOUT_MS: "300",
      GENIUS_HARNESS_DEBUG: "1",
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[genius-harness-supply]");
  });
});