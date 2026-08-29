import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkBuildFreshness, formatBuildFreshnessWarning } from "../../src/runtime/build-freshness.js";

describe("checkBuildFreshness", () => {
  let root: string;
  let srcDir: string;
  let distDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "genius-build-freshness-"));
    srcDir = join(root, "src");
    distDir = join(root, "dist");
    await mkdir(join(srcDir, "ingest"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reports fresh when dist is newer than src", async () => {
    const srcFile = join(srcDir, "ingest", "ingest-service.ts");
    const distFile = join(distDir, "ingest", "ingest-service.js");
    await mkdir(join(distDir, "ingest"), { recursive: true });
    await writeFile(srcFile, "export {}\n");
    await writeFile(distFile, "export {}\n");
    const past = new Date(Date.now() - 60_000);
    await utimes(srcFile, past, past);

    const result = await checkBuildFreshness(srcDir, distDir);

    expect(result.stale).toBe(false);
    expect(result.staleSample).toBeNull();
  });

  it("reports stale when a source file is newer than its compiled output", async () => {
    const srcFile = join(srcDir, "ingest", "ingest-service.ts");
    const distFile = join(distDir, "ingest", "ingest-service.js");
    await mkdir(join(distDir, "ingest"), { recursive: true });
    await writeFile(distFile, "export {}\n");
    const past = new Date(Date.now() - 60_000);
    await utimes(distFile, past, past);
    await writeFile(srcFile, "export {}\n");

    const result = await checkBuildFreshness(srcDir, distDir);

    expect(result.stale).toBe(true);
    expect(result.staleSample).toBe(join("ingest", "ingest-service.ts"));
  });

  it("does not flag staleness when the dist directory is absent", async () => {
    const srcFile = join(srcDir, "ingest", "ingest-service.ts");
    await writeFile(srcFile, "export {}\n");

    const result = await checkBuildFreshness(srcDir, distDir);

    expect(result.stale).toBe(false);
  });

  it("reports stale when dist exists but a compiled output is missing", async () => {
    const srcFile = join(srcDir, "ingest", "ingest-service.ts");
    await mkdir(distDir);
    await writeFile(srcFile, "export {}\n");

    const result = await checkBuildFreshness(srcDir, distDir);

    expect(result.stale).toBe(true);
    expect(result.staleSample).toBe(join("ingest", "ingest-service.ts"));
  });

  it("ignores .d.ts declaration files", async () => {
    const srcFile = join(srcDir, "ingest", "ingest-service.d.ts");
    await mkdir(distDir);
    await writeFile(srcFile, "export {}\n");

    const result = await checkBuildFreshness(srcDir, distDir);

    expect(result.stale).toBe(false);
  });
});

describe("formatBuildFreshnessWarning", () => {
  it("names the stale sample file and the remediation command", () => {
    const message = formatBuildFreshnessWarning({
      stale: true,
      staleSample: "ingest/ingest-service.ts",
    });

    expect(message).toContain("ingest/ingest-service.ts");
    expect(message).toContain("npm run build");
  });
});
