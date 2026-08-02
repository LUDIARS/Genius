/**
 * 蒸留パイプラインが自前で組み立てる「管理されたメッセージ」を持つエラー。
 *
 * failure-classification はこれらのメッセージを ingest_failures / 通知へ
 * そのまま (切り詰めて) 転記してよい。文書本文・LLM 出力の生テキストを
 * メッセージに入れないことが送出側の契約 (spec/feature/operations.md §4)。
 */

/** LLM backend (claude-cli / ollama) の呼び出し失敗。exit code や HTTP status など。 */
export class DistillationBackendError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DistillationBackendError";
  }
}

/**
 * LLM 出力が JSON として抽出・検証できなかった失敗。message は attempt ごとの
 * bounded な要約 (エラー名 + 位置 / Zod issue の code と path) のみで、
 * LLM 出力の断片は含まない。
 */
export class DistillationOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DistillationOutputError";
  }
}
