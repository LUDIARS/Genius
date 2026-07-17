import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    // The optional real-Ollama tests share one local model runner. File-level
    // parallelism would measure resource contention rather than query latency.
    fileParallelism: false,
    include: ["test/**/*.test.ts"],
    pool: "forks",
    testTimeout: 30_000,
  },
});
