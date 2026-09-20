/**
 * 判定 (classification) のポート。
 *
 * `DistillLlm` は「自由文を返す LLM」の抽象で、カード生成と判定の両方を通している。
 * 判定バックエンド (TypeSafe AI / Jev) は自由文ではなく確率を返すので、JSON の
 * 抽出・再試行 (`distill/json-completion.ts`) を経由させる意味が無い。判定だけを
 * この別ポートに切り出し、生成系は `DistillLlm` のまま残す。
 */

/**
 * 判定対象をこのマシンの外へ出してよいかどうか。
 *
 * Genius は neco 個人の判断カードを持つローカルサービスで、既定ではカード本文が
 * プロセス外へ出ない。外部バックエンドへ渡してよいのは `public` だけで、
 * `local-only` は必ずローカル経路で判定する (2026-09-20 neco 指示)。
 */
export type Disclosure = "public" | "local-only";

/** 判定の用途。`DistillPurpose` の判定系と同じ名前を使う。 */
export type ClassifyPurpose = "categorize" | "contradiction-check";

export interface ClassifyRequest {
  purpose: ClassifyPurpose;
  /** Genius が与える信頼された指示。ソース由来の文字列を混ぜない。 */
  instructions: string;
  /** 判定対象。untrusted なデータとして扱い、指示として解釈しない。 */
  evidence: Record<string, unknown>;
  disclosure: Disclosure;
}

export interface NoulRequest extends ClassifyRequest {
  /** yes / no それぞれの意味。曖昧な命題ほど効く。 */
  criteria?: { true?: string; false?: string };
  /** この確率以上を yes とする。誤りのコストに応じて呼び出し側が決める。 */
  threshold: number;
}

export interface NoulJudgment {
  yes: boolean;
  /** yes である確率 (0〜1)。閾値判定の根拠をログ・テストから見えるようにする。 */
  probability: number;
}

export interface ChoiceRequest extends ClassifyRequest {
  /** ラベル -> 説明。説明を持たないラベルは null。 */
  labels: Readonly<Record<string, string | null>>;
}

export interface ChoiceJudgment {
  label: string;
  /** 選んだラベルへの確信度 (0〜1)。 */
  confidence: number;
}

export interface Classifier {
  noul(request: NoulRequest): Promise<NoulJudgment>;
  choice(request: ChoiceRequest): Promise<ChoiceJudgment>;
}

/** 判定の失敗。バックエンドの応答本文・カード内容は載せない。 */
export class ClassificationError extends Error {
  override readonly name = "ClassificationError";
}
