import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGeniusHttpClientFromEnvironment } from "../client/genius-http-client.js";
import { createGeniusMcpServer } from "./create-server.js";

export async function runGeniusMcpServer(): Promise<void> {
  const queryClient = createGeniusHttpClientFromEnvironment();
  const server = createGeniusMcpServer(queryClient);
  await server.connect(new StdioServerTransport());
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry);
}

if (isEntrypoint()) {
  try {
    await runGeniusMcpServer();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Genius MCP server failed: ${message}\n`);
    process.exitCode = 1;
  }
}
