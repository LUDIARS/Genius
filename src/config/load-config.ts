import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { ConfigError } from "./errors.js";
import { normalizeLoopbackHttpUrl } from "./loopback-url.js";
import type { LoadedGeniusConfig, SourceConfig } from "./types.js";

const sourceConfigSchema = z
  .object({
    memoryDir: z.string().trim().min(1).nullable(),
    sessionLogsDir: z.string().trim().min(1).nullable(),
    channelArchivesDir: z.string().trim().min(1).nullable(),
    reviewDir: z.string().trim().min(1).nullable(),
    claudeProjectsDir: z.string().trim().min(1).nullable(),
    codexSessionsDir: z.string().trim().min(1).nullable(),
    memoriaBaseUrl: z.string().trim().url().nullable(),
  })
  .strict();

const configSchema = z
  .object({
    port: z.number().int().min(1).max(65_535),
    dataDir: z.string().trim().min(1),
    embedding: z
      .object({
        baseUrl: z.string().trim().min(1),
        model: z.string().trim().min(1),
        dim: z.literal(1024),
        numGpu: z.number().int().min(0).nullable().optional().default(null),
        keepAlive: z.string().trim().min(1).nullable().optional().default(null),
      })
      .strict(),
    distill: z
      .object({
        backend: z.enum(["claude-cli", "ollama"]),
        model: z.string().trim().min(1),
        sensitiveCheckModel: z.string().trim().min(1),
        ollamaModel: z.string().trim().min(1),
      })
      .strict(),
    sources: sourceConfigSchema,
    // notify 節が無い既存 config を壊さないため optional。既定は「通知無効」
    // だが無言にはせず、createRuntime が起動時に 1 行明示する。
    notify: z
      .object({
        concordiaBaseUrl: z.string().trim().min(1).nullable(),
      })
      .strict()
      .optional()
      .default({ concordiaBaseUrl: null }),
  })
  .strict();

export const CONFIG_ENVIRONMENT_VARIABLES = {
  port: "GENIUS_PORT",
  dataDir: "GENIUS_DATA_DIR",
  embeddingBaseUrl: "GENIUS_EMBEDDING_BASE_URL",
  embeddingModel: "GENIUS_EMBEDDING_MODEL",
  embeddingDim: "GENIUS_EMBEDDING_DIM",
  embeddingNumGpu: "GENIUS_EMBEDDING_NUM_GPU",
  embeddingKeepAlive: "GENIUS_EMBEDDING_KEEP_ALIVE",
  distillBackend: "GENIUS_DISTILL_BACKEND",
  distillModel: "GENIUS_DISTILL_MODEL",
  sensitiveCheckModel: "GENIUS_DISTILL_SENSITIVE_CHECK_MODEL",
  distillOllamaModel: "GENIUS_DISTILL_OLLAMA_MODEL",
  memoryDir: "GENIUS_SOURCE_MEMORY_DIR",
  sessionLogsDir: "GENIUS_SOURCE_SESSION_LOGS_DIR",
  channelArchivesDir: "GENIUS_SOURCE_CHANNEL_ARCHIVES_DIR",
  reviewDir: "GENIUS_SOURCE_REVIEW_DIR",
  claudeProjectsDir: "GENIUS_SOURCE_CLAUDE_PROJECTS_DIR",
  codexSessionsDir: "GENIUS_SOURCE_CODEX_SESSIONS_DIR",
  memoriaBaseUrl: "GENIUS_SOURCE_MEMORIA_BASE_URL",
  notifyConcordiaBaseUrl: "GENIUS_NOTIFY_CONCORDIA_BASE_URL",
} as const;

export interface LoadConfigOptions {
  cwd?: string;
  configPath?: string;
  environment?: NodeJS.ProcessEnv;
}

type MutableJsonObject = Record<string, unknown>;

function objectAt(value: MutableJsonObject, key: string): MutableJsonObject {
  const child = value[key];
  if (typeof child !== "object" || child === null || Array.isArray(child)) {
    const replacement: MutableJsonObject = {};
    value[key] = replacement;
    return replacement;
  }
  return child as MutableJsonObject;
}

function environmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = environment[name];
  if (value === undefined) return undefined;
  if (value.trim() === "") {
    throw new ConfigError(`${name} must not be empty`);
  }
  return value.trim();
}

function strictInteger(value: string, name: string): number {
  if (!/^-?\d+$/.test(value)) {
    throw new ConfigError(`${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ConfigError(`${name} must be a safe integer`);
  }
  return parsed;
}

function applyEnvironmentOverrides(
  raw: MutableJsonObject,
  environment: NodeJS.ProcessEnv,
): MutableJsonObject {
  const result = structuredClone(raw);
  const embedding = objectAt(result, "embedding");
  const distill = objectAt(result, "distill");
  const sources = objectAt(result, "sources");

  const notifyConcordiaBaseUrl = environmentValue(
    environment,
    CONFIG_ENVIRONMENT_VARIABLES.notifyConcordiaBaseUrl,
  );
  if (notifyConcordiaBaseUrl !== undefined) {
    objectAt(result, "notify").concordiaBaseUrl = notifyConcordiaBaseUrl;
  }

  const port = environmentValue(environment, CONFIG_ENVIRONMENT_VARIABLES.port);
  if (port !== undefined) result.port = strictInteger(port, CONFIG_ENVIRONMENT_VARIABLES.port);
  const dataDir = environmentValue(environment, CONFIG_ENVIRONMENT_VARIABLES.dataDir);
  if (dataDir !== undefined) result.dataDir = dataDir;

  const embeddingBaseUrl = environmentValue(
    environment,
    CONFIG_ENVIRONMENT_VARIABLES.embeddingBaseUrl,
  );
  if (embeddingBaseUrl !== undefined) embedding.baseUrl = embeddingBaseUrl;
  const embeddingModel = environmentValue(
    environment,
    CONFIG_ENVIRONMENT_VARIABLES.embeddingModel,
  );
  if (embeddingModel !== undefined) embedding.model = embeddingModel;
  const embeddingDim = environmentValue(
    environment,
    CONFIG_ENVIRONMENT_VARIABLES.embeddingDim,
  );
  if (embeddingDim !== undefined) {
    embedding.dim = strictInteger(embeddingDim, CONFIG_ENVIRONMENT_VARIABLES.embeddingDim);
  }
  const embeddingNumGpu = environmentValue(
    environment,
    CONFIG_ENVIRONMENT_VARIABLES.embeddingNumGpu,
  );
  if (embeddingNumGpu !== undefined) {
    embedding.numGpu = strictInteger(embeddingNumGpu, CONFIG_ENVIRONMENT_VARIABLES.embeddingNumGpu);
  }
  const embeddingKeepAlive = environmentValue(
    environment,
    CONFIG_ENVIRONMENT_VARIABLES.embeddingKeepAlive,
  );
  if (embeddingKeepAlive !== undefined) embedding.keepAlive = embeddingKeepAlive;

  const distillBackend = environmentValue(
    environment,
    CONFIG_ENVIRONMENT_VARIABLES.distillBackend,
  );
  if (distillBackend !== undefined) distill.backend = distillBackend;
  const distillModel = environmentValue(
    environment,
    CONFIG_ENVIRONMENT_VARIABLES.distillModel,
  );
  if (distillModel !== undefined) distill.model = distillModel;
  const sensitiveCheckModel = environmentValue(
    environment,
    CONFIG_ENVIRONMENT_VARIABLES.sensitiveCheckModel,
  );
  if (sensitiveCheckModel !== undefined) distill.sensitiveCheckModel = sensitiveCheckModel;
  const distillOllamaModel = environmentValue(
    environment,
    CONFIG_ENVIRONMENT_VARIABLES.distillOllamaModel,
  );
  if (distillOllamaModel !== undefined) distill.ollamaModel = distillOllamaModel;

  const sourceOverrides: readonly [keyof SourceConfig, string][] = [
    ["memoryDir", CONFIG_ENVIRONMENT_VARIABLES.memoryDir],
    ["sessionLogsDir", CONFIG_ENVIRONMENT_VARIABLES.sessionLogsDir],
    ["channelArchivesDir", CONFIG_ENVIRONMENT_VARIABLES.channelArchivesDir],
    ["reviewDir", CONFIG_ENVIRONMENT_VARIABLES.reviewDir],
    ["claudeProjectsDir", CONFIG_ENVIRONMENT_VARIABLES.claudeProjectsDir],
    ["codexSessionsDir", CONFIG_ENVIRONMENT_VARIABLES.codexSessionsDir],
    ["memoriaBaseUrl", CONFIG_ENVIRONMENT_VARIABLES.memoriaBaseUrl],
  ];
  for (const [key, variable] of sourceOverrides) {
    const value = environmentValue(environment, variable);
    if (value !== undefined) sources[key] = value;
  }
  return result;
}

function resolveFileSystemLocation(value: string, configDirectory: string): string {
  return isAbsolute(value) ? value : resolve(configDirectory, value);
}

function resolveSourceLocations(
  sources: SourceConfig,
  configDirectory: string,
): SourceConfig {
  return {
    memoryDir:
      sources.memoryDir === null
        ? null
        : resolveFileSystemLocation(sources.memoryDir, configDirectory),
    sessionLogsDir:
      sources.sessionLogsDir === null
        ? null
        : resolveFileSystemLocation(sources.sessionLogsDir, configDirectory),
    channelArchivesDir:
      sources.channelArchivesDir === null
        ? null
        : resolveFileSystemLocation(sources.channelArchivesDir, configDirectory),
    reviewDir:
      sources.reviewDir === null
        ? null
        : resolveFileSystemLocation(sources.reviewDir, configDirectory),
    claudeProjectsDir:
      sources.claudeProjectsDir === null
        ? null
        : resolveFileSystemLocation(sources.claudeProjectsDir, configDirectory),
    codexSessionsDir:
      sources.codexSessionsDir === null
        ? null
        : resolveFileSystemLocation(sources.codexSessionsDir, configDirectory),
    memoriaBaseUrl:
      sources.memoriaBaseUrl === null
        ? null
        : normalizeLoopbackHttpUrl(sources.memoriaBaseUrl, "sources.memoriaBaseUrl"),
  };
}

function missingConfigError(configPath: string): ConfigError {
  const configDirectory = dirname(configPath);
  const examplePath = join(configDirectory, "genius.config.example.json");
  const exampleNote = existsSync(examplePath)
    ? `Example found at ${examplePath}. `
    : "";
  return new ConfigError(
    `Required config file not found: ${configPath}. ${exampleNote}` +
      "Copy genius.config.example.json to genius.config.json and configure local sources.",
  );
}

export function loadConfig(options: LoadConfigOptions = {}): LoadedGeniusConfig {
  const cwd = options.cwd ?? process.cwd();
  const configPath = resolve(options.configPath ?? join(cwd, "genius.config.json"));
  if (!existsSync(configPath)) throw missingConfigError(configPath);

  let decoded: unknown;
  try {
    decoded = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new ConfigError(`Failed to parse config file: ${configPath}`, { cause: error });
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new ConfigError(`Config root must be an object: ${configPath}`);
  }

  const overridden = applyEnvironmentOverrides(
    decoded as MutableJsonObject,
    options.environment ?? process.env,
  );
  const parsed = configSchema.safeParse(overridden);
  if (!parsed.success) {
    throw new ConfigError(`Invalid config ${configPath}: ${z.prettifyError(parsed.error)}`);
  }

  const configDirectory = dirname(configPath);
  return {
    ...parsed.data,
    dataDir: resolveFileSystemLocation(parsed.data.dataDir, configDirectory),
    embedding: {
      ...parsed.data.embedding,
      baseUrl: normalizeLoopbackHttpUrl(
        parsed.data.embedding.baseUrl,
        "embedding.baseUrl",
      ),
    },
    sources: resolveSourceLocations(parsed.data.sources, configDirectory),
    notify: {
      concordiaBaseUrl:
        parsed.data.notify.concordiaBaseUrl === null
          ? null
          : normalizeLoopbackHttpUrl(
              parsed.data.notify.concordiaBaseUrl,
              "notify.concordiaBaseUrl",
            ),
    },
    configPath,
  };
}
