import { serve } from "@hono/node-server";
import { createRuntime } from "./runtime/create-runtime.js";
import { closeServerAndRuntime } from "./runtime/shutdown-resources.js";

async function main(): Promise<void> {
  const runtime = await createRuntime();
  const { bindHost, allowedOrigins } = runtime.config.server;
  const server = serve({
    fetch: runtime.app.fetch,
    hostname: bindHost,
    port: runtime.config.port,
  });
  // Genius は認証を持たない。 loopback の外に出す判断は設定に書かれた通りに
  // 実行するが、 黙って実行はしない (spec/feature/operations.md §5)。
  process.stderr.write(
    `[listen] ${JSON.stringify(bindHost)}:${runtime.config.port}`
    + (isLoopbackBind(bindHost)
      ? "\n"
      : ` — reachable beyond this machine; access control is expected in front of Genius.`
        + ` allowedOrigins=${allowedOrigins.length}\n`),
  );
  let isClosing = false;
  const shutdown = (signal: string, exitCode: number): void => {
    if (isClosing) return;
    isClosing = true;
    process.stderr.write(`[shutdown] ${signal}\n`);
    void (async () => {
      try {
        await closeServerAndRuntime(
          () => closeServer(server),
          () => runtime.close(),
        );
        process.exitCode = exitCode;
      } catch (closeError) {
        const detail = closeError instanceof Error ? closeError.stack ?? closeError.message : String(closeError);
        process.stderr.write(`[fatal] Shutdown failed: ${detail}\n`);
        process.exitCode = 1;
      }
    })();
  };

  process.once("SIGINT", () => shutdown("SIGINT", 0));
  process.once("SIGTERM", () => shutdown("SIGTERM", 0));
  process.once("uncaughtException", (error) => {
    process.stderr.write(`[fatal] uncaughtException: ${error.stack ?? error.message}\n`);
    shutdown("uncaughtException", 1);
  });
  process.once("unhandledRejection", (reason) => {
    const detail = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    process.stderr.write(`[fatal] unhandledRejection: ${detail}\n`);
    shutdown("unhandledRejection", 1);
  });
}

function isLoopbackBind(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function closeServer(
  server: ReturnType<typeof serve>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

try {
  await main();
} catch (error) {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[fatal] Genius startup failed: ${detail}\n`);
  process.exitCode = 1;
}
