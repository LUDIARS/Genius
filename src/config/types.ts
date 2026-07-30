export const SOURCE_CONFIG_KEYS = {
  memory: "memoryDir",
  "session-logs": "sessionLogsDir",
  "channel-archives": "channelArchivesDir",
  review: "reviewDir",
  memoria: "memoriaBaseUrl",
  "claude-jsonl": "claudeProjectsDir",
  "codex-jsonl": "codexSessionsDir",
} as const;

export type SourceName = keyof typeof SOURCE_CONFIG_KEYS;
export type SourceConfigKey = (typeof SOURCE_CONFIG_KEYS)[SourceName];

export const TIER_ONE_SOURCES = [
  "memory",
  "session-logs",
  "channel-archives",
  "review",
  "memoria",
] as const satisfies readonly SourceName[];

export const TIER_TWO_SOURCES = [
  "claude-jsonl",
  "codex-jsonl",
] as const satisfies readonly SourceName[];

export interface SourceConfig {
  memoryDir: string | null;
  sessionLogsDir: string | null;
  channelArchivesDir: string | null;
  reviewDir: string | null;
  claudeProjectsDir: string | null;
  codexSessionsDir: string | null;
  memoriaBaseUrl: string | null;
}

export interface EmbeddingConfig {
  baseUrl: string;
  model: string;
  dim: 1024;
  numGpu: number | null;
  /** Ollama `keep_alive` (e.g. "30m", "-1"). Null uses the daemon default. */
  keepAlive: string | null;
}

export interface DistillConfig {
  backend: "claude-cli" | "ollama";
  model: string;
  sensitiveCheckModel: string;
  ollamaModel: string;
}

export interface NotifyConfig {
  /**
   * 失敗 run (failed / completed-with-errors) を通知する Concordia の base URL。
   * loopback のみ許可。null = 通知無効 (起動時に 1 行明示する)。
   */
  concordiaBaseUrl: string | null;
}

export interface GeniusConfig {
  port: number;
  dataDir: string;
  embedding: EmbeddingConfig;
  distill: DistillConfig;
  sources: SourceConfig;
  notify: NotifyConfig;
}

export interface LoadedGeniusConfig extends GeniusConfig {
  configPath: string;
}

export interface ResolvedSource {
  name: SourceName;
  location: string;
}

export interface SourceResolution {
  configured: ResolvedSource[];
  skipped: SourceName[];
}
