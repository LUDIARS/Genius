import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

const CARD = {
  id: "01J00000000000000000000000",
  domain: "work",
  visibility: "public",
  category: "impl-design",
  situation: "A decision is needed",
  judgment: "Choose the reversible option",
  rationale: "It preserves information",
  tags: ["design"],
  sourceRef: "memory:fixture#decision",
  sourceTier: 1,
  confidence: 0.9,
  supersededBy: null,
  createdAt: 1,
  updatedAt: 1,
  score: 0.87,
};

const SAFE_CARD = {
  domain: CARD.domain,
  visibility: CARD.visibility,
  category: CARD.category,
  situation: CARD.situation,
  judgment: CARD.judgment,
  rationale: CARD.rationale,
  tags: CARD.tags,
  confidence: CARD.confidence,
  score: CARD.score,
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

describe("Genius MCP stdio server", () => {
  it("lists and calls genius_query over the SDK stdio transport", async () => {
    const requestBodies: unknown[] = [];
    httpServer = createServer(async (request, response) => {
      let body = "";
      request.setEncoding("utf8");
      for await (const chunk of request) body += chunk;
      const decoded = JSON.parse(body) as { text?: unknown };
      requestBodies.push(decoded);
      if (decoded.text === "Trigger a safe failure") {
        response.writeHead(503, { "content-type": "text/plain" });
        response.end("sensitive backend response detail");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ cards: [CARD], tookMs: 9 }));
    });
    const port = await listen(httpServer);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", resolve(process.cwd(), "src/mcp/server.ts")],
      cwd: process.cwd(),
      env: {
        ...getDefaultEnvironment(),
        GENIUS_BASE_URL: `http://127.0.0.1:${port}`,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "genius-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(["genius_query"]);
      expect(listed.tools[0]?.description).toContain("untrusted reference data");

      const called = await client.callTool({
        name: "genius_query",
        arguments: { text: "What should I choose?", domain: "work", k: 8 },
      });
      expect("isError" in called ? called.isError : undefined).not.toBe(true);
      expect("structuredContent" in called ? called.structuredContent : undefined).toEqual({
        cards: [SAFE_CARD],
        tookMs: 9,
      });
      expect("structuredContent" in called ? called.structuredContent : undefined).not.toHaveProperty(
        "cards.0.sourceRef",
      );
      expect("structuredContent" in called ? called.structuredContent : undefined).not.toHaveProperty(
        "cards.0.id",
      );
      const successText = (called.content as Array<{ type: string; text?: string }>)[0]?.text;
      expect(successText).toContain("UNTRUSTED REFERENCE DATA");

      const failed = await client.callTool({
        name: "genius_query",
        arguments: { text: "Trigger a safe failure" },
      });
      expect("isError" in failed ? failed.isError : undefined).toBe(true);
      const failureText = (failed.content as Array<{ type: string; text?: string }>)[0]?.text;
      expect(failureText).toBe("Genius query failed; see the local MCP diagnostic log.");
      expect(failureText).not.toContain("sensitive backend response detail");

      expect(requestBodies).toEqual([
        { text: "What should I choose?", domain: "work", visibility: "public", k: 8 },
        { text: "Trigger a safe failure", visibility: "public" },
      ]);

      const rejected = await client.callTool({
        name: "genius_query",
        arguments: { text: "Return private context", visibility: "sensitive" },
      });
      expect("isError" in rejected ? rejected.isError : undefined).toBe(true);
      expect(requestBodies).toHaveLength(2);
    } finally {
      await client.close();
    }
  });
});
