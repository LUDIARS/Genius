import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("config-required process behavior", () => {
  it("exits nonzero and prints copy instructions to stderr", () => {
    const directory = mkdtempSync(join(tmpdir(), "genius-missing-config-"));
    writeFileSync(join(directory, "genius.config.example.json"), "{}", "utf8");
    const result = spawnSync(
      process.execPath,
      [
        resolve("node_modules/tsx/dist/cli.mjs"),
        resolve("src/db/migrate-cli.ts"),
      ],
      {
        cwd: directory,
        encoding: "utf8",
        env: process.env,
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Copy genius.config.example.json to genius.config.json",
    );
  });
});
