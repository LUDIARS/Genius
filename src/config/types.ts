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

/**
 * 判定 (classification) バックエンド。
 *
 * `distill-llm` = distill と同じローカル LLM だけを使う (既定)。カード内容は
 * このマシンから出ない。`jev` = TypeSafe AI (Jev) を足すが、外へ出るのは
 * 公開安全な判定だけ (2026-09-20 neco 指示 — 送出範囲は
 * `classify/disclosure-routed-classifier.ts` が唯一の判断点)。
 */
export interface ClassifierConfig {
  backend: "distill-llm" | "jev";
  /** null なら SDK が `TYPESAFE_API_KEY` を読む。config に直書きもできる。 */
  apiKey: string | null;
  /** null なら SDK 既定 (`jev-latest`)。 */
  model: string | null;
  /** null なら SDK 既定 (`https://api.typesafe.ai`)。 */
  baseUrl: string | null;
  /** 1 試行あたりのタイムアウト (ms)。 */
  timeoutMs: number;
  /** 矛盾と判定する Noul 確率の下限。見逃しより誤検知の方が安いので低めに置く。 */
  contradictionThreshold: number;
}

export interface NotifyConfig {
  /**
   * 失敗 run (failed / completed-with-errors) を通知する Concordia の base URL。
   * loopback のみ許可。null = 通知無効 (起動時に 1 行明示する)。
   */
  concordiaBaseUrl: string | null;
}

export interface QuestionsConfig {
  enabled: boolean;
  maxPerRun: number;
  maxOpen: number;
  lowConfidenceBelow: number;
  /** Query top1 similarity below this value is a retrieval-miss gap. */
  retrievalMissBelow: number;
  /** notify.concordiaBaseUrl が null なら実質無効 (起動時に 1 行明示する)。 */
  discordEnabled: boolean;
  /**
   * 判断者の Discord user id。 この人の返信だけを回答として採る。
   * null = 未設定。 Discord からの回答取り込みを止める (起動時に 1 行明示する) —
   * 誰の判断か決まらないまま取り込むと、別人の判断がクローンへ混ざるため。
   */
  deciderDiscordUserId: string | null;
}

export interface ContradictionConfig {
  situationSimilarityMin: number;
  judgmentSimilarityMax: number;
}

export interface QueryLogConfig {
  enabled: boolean;
  retentionDays: number;
}

export interface ServerConfig {
  /**
   * Interface the HTTP listener binds to. `127.0.0.1` keeps Genius reachable
   * only from this machine; `0.0.0.0` publishes it to every interface, which is
   * what a tunnel or reverse proxy in front of Genius needs.
   */
  bindHost: string;
  /**
   * Origins allowed in addition to loopback. Genius has no authentication, so
   * an entry here is a deliberate statement that the named front door is
   * already access-controlled by something else.
   */
  allowedOrigins: string[];
}

export interface GeniusConfig {
  port: number;
  server: ServerConfig;
  dataDir: string;
  embedding: EmbeddingConfig;
  distill: DistillConfig;
  classifier: ClassifierConfig;
  sources: SourceConfig;
  notify: NotifyConfig;
  questions: QuestionsConfig;
  contradiction: ContradictionConfig;
  queryLog: QueryLogConfig;
  feedback: FeedbackConfig;
  cardGroupCache: CardGroupCacheConfig;
}

/** 評価によるアーカイブの閾値 (spec/feature/card-feedback.md §4)。 */
export interface FeedbackConfig {
  /** これ未満の poor 件数では落とさない。 */
  minimumPoor: number;
  /** poor / (great + good + poor) がこの値以上なら落とす。 */
  poorRatio: number;
}

/** 頻出カードグループのキャッシュ (spec/feature/operations.md §10)。 */
export interface CardGroupCacheConfig {
  /** この回数だけ引かれた絞り込みを「頻出」とみなして保存する。 */
  hotThreshold: number;
  /** 保存結果と頻度記録の上限 (超過分は最後に使われたものから捨てる)。 */
  maxEntries: number;
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
