import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  loadConfig,
  resolveConfiguredSources,
} from "../src/config/index.js";

function validConfig(): Record<string, unknown> {
  return {
    port: 4230,
    dataDir: "./data",
    embedding: {
      baseUrl: "http://127.0.0.1:11434",
      model: "bge-m3",
      dim: 1024,
    },
    distill: {
      backend: "claude-cli",
      model: "test-distill-model",
      sensitiveCheckModel: "test-sensitive-model",
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
  };
}

function fixtureDirectory(): string {
  return mkdtempSync(join(tmpdir(), "genius-config-"));
}

function writeConfig(directory: string, config = validConfig()): string {
  const configPath = join(directory, "genius.config.json");
  writeFileSync(configPath, JSON.stringify(config), "utf8");
  return configPath;
}

describe("loadConfig", () => {
  it("fails with a copy instruction when only the example exists", () => {
    const directory = fixtureDirectory();
    writeFileSync(join(directory, "genius.config.example.json"), "{}", "utf8");

    expect(() => loadConfig({ cwd: directory, environment: {} })).toThrowError(
      /Copy genius\.config\.example\.json to genius\.config\.json/,
    );
  });

  it("applies documented environment overrides and resolves local paths", () => {
    const directory = fixtureDirectory();
    const configPath = writeConfig(directory);
    const config = loadConfig({
      configPath,
      environment: {
        GENIUS_PORT: "4321",
        GENIUS_DATA_DIR: "./runtime-data",
        GENIUS_EMBEDDING_NUM_GPU: "0",
        GENIUS_SOURCE_MEMORY_DIR: "./memory",
      },
    });

    expect(config.port).toBe(4321);
    expect(config.dataDir).toBe(join(directory, "runtime-data"));
    expect(config.embedding.numGpu).toBe(0);
    expect(config.sources.memoryDir).toBe(join(directory, "memory"));
  });

  it("rejects invalid integer overrides instead of falling back", () => {
    const configPath = writeConfig(fixtureDirectory());
    expect(() =>
      loadConfig({ configPath, environment: { GENIUS_PORT: "4230x" } }),
    ).toThrowError(ConfigError);
  });

  it("rejects a non-loopback embedding URL", () => {
    const directory = fixtureDirectory();
    const config = validConfig();
    config.embedding = {
      baseUrl: "https://embedding.invalid",
      model: "bge-m3",
      dim: 1024,
    };
    const configPath = writeConfig(directory, config);

    expect(() => loadConfig({ configPath, environment: {} })).toThrowError(
      /loopback host/,
    );
  });

  it("rejects a non-loopback Memoria URL", () => {
    const directory = fixtureDirectory();
    const config = validConfig();
    const sources = config.sources as Record<string, unknown>;
    sources.memoriaBaseUrl = "https://memoria.invalid";
    const configPath = writeConfig(directory, config);

    expect(() => loadConfig({ configPath, environment: {} })).toThrowError(/loopback host/);
  });

  it("applies the documented keep-alive override", () => {
    const configPath = writeConfig(fixtureDirectory());
    const config = loadConfig({
      configPath,
      environment: { GENIUS_EMBEDDING_KEEP_ALIVE: "30m" },
    });

    expect(config.embedding.keepAlive).toBe("30m");
  });

  it("allows null sources at load and fails only when selected", () => {
    const config = loadConfig({
      configPath: writeConfig(fixtureDirectory()),
      environment: {},
    });

    expect(config.embedding.numGpu).toBeNull();
    expect(config.embedding.keepAlive).toBeNull();
    expect(() => resolveConfiguredSources(config, ["memory"], false)).toThrowError(
      /memoryDir is null/,
    );
    expect(resolveConfiguredSources(config, ["memory"], true)).toEqual({
      configured: [],
      skipped: ["memory"],
    });
  });
});
