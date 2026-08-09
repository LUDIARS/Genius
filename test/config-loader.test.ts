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

  it("keeps a config without a server section loopback-only", () => {
    const config = loadConfig({ configPath: writeConfig(fixtureDirectory()), environment: {} });

    expect(config.server.bindHost).toBe("127.0.0.1");
    expect(config.server.allowedOrigins).toEqual([]);
  });

  it("publishes the listener and the declared origin when both are configured", () => {
    const config = validConfig();
    config.server = {
      bindHost: "0.0.0.0",
      allowedOrigins: ["https://genius.example.com"],
    };
    const configPath = writeConfig(fixtureDirectory(), config);

    const loaded = loadConfig({ configPath, environment: {} });

    expect(loaded.server.bindHost).toBe("0.0.0.0");
    expect(loaded.server.allowedOrigins).toEqual(["https://genius.example.com"]);
  });

  it("accepts the documented server overrides from the environment", () => {
    const configPath = writeConfig(fixtureDirectory());

    const loaded = loadConfig({
      configPath,
      environment: {
        GENIUS_BIND_HOST: "0.0.0.0",
        GENIUS_ALLOWED_ORIGINS: "https://a.example.com, https://b.example.com",
      },
    });

    expect(loaded.server.bindHost).toBe("0.0.0.0");
    expect(loaded.server.allowedOrigins).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
  });

  it("rejects empty entries in the origin environment override", () => {
    const configPath = writeConfig(fixtureDirectory());

    expect(() => loadConfig({
      configPath,
      environment: {
        GENIUS_ALLOWED_ORIGINS: "https://a.example.com,,https://b.example.com",
      },
    })).toThrowError(ConfigError);
  });

  it("rejects an allowed origin that is not exactly an origin", () => {
    for (const origin of [
      "https://genius.example.com/ui",
      "https://user:pw@genius.example.com",
      "genius.example.com",
      "ftp://genius.example.com",
    ]) {
      const config = validConfig();
      config.server = { bindHost: "127.0.0.1", allowedOrigins: [origin] };
      const configPath = writeConfig(fixtureDirectory(), config);

      expect(() => loadConfig({ configPath, environment: {} })).toThrowError(ConfigError);
    }
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

  it("defaults notify to disabled and honors the documented override", () => {
    const disabled = loadConfig({
      configPath: writeConfig(fixtureDirectory()),
      environment: {},
    });
    expect(disabled.notify.concordiaBaseUrl).toBeNull();

    const enabled = loadConfig({
      configPath: writeConfig(fixtureDirectory()),
      environment: { GENIUS_NOTIFY_CONCORDIA_BASE_URL: "http://127.0.0.1:14500" },
    });
    expect(enabled.notify.concordiaBaseUrl).toBe("http://127.0.0.1:14500");
  });

  it("defaults the questions / contradiction / queryLog sections when absent", () => {
    const config = loadConfig({
      configPath: writeConfig(fixtureDirectory()),
      environment: {},
    });
    expect(config.questions).toEqual({
      enabled: true,
      maxPerRun: 5,
      maxOpen: 20,
      lowConfidenceBelow: 0.5,
      retrievalMissBelow: 0.5,
      discordEnabled: true,
    });
    expect(config.contradiction).toEqual({
      situationSimilarityMin: 0.85,
      judgmentSimilarityMax: 0.5,
    });
    expect(config.queryLog).toEqual({ enabled: true, retentionDays: 30 });
  });

  it("rejects invalid questions / queryLog values instead of falling back", () => {
    const directory = fixtureDirectory();
    const config = validConfig();
    config.questions = { maxPerRun: 0 };
    expect(() =>
      loadConfig({ configPath: writeConfig(directory, config), environment: {} }),
    ).toThrowError(/Invalid config/);

    const other = validConfig();
    other.queryLog = { retentionDays: -1 };
    expect(() =>
      loadConfig({
        configPath: writeConfig(fixtureDirectory(), other),
        environment: {},
      }),
    ).toThrowError(/Invalid config/);
  });

  it("rejects a non-loopback Concordia notify URL", () => {
    const directory = fixtureDirectory();
    const config = validConfig();
    config.notify = { concordiaBaseUrl: "https://concordia.invalid" };
    const configPath = writeConfig(directory, config);

    expect(() => loadConfig({ configPath, environment: {} })).toThrowError(/loopback host/);
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
