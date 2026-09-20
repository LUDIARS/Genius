import { TypeSafeClient, choice, noul, type Fetch } from "@typesafe-ai/sdk";
import {
  ClassificationError,
  type ChoiceJudgment,
  type ChoiceRequest,
  type Classifier,
  type NoulJudgment,
  type NoulRequest,
} from "./classifier.js";

/**
 * 1 リクエストに 1 問だけ載せるので、解答キーは固定で良い。SDK は
 * `answers[<キー>]` を問い合わせたキーで型付けする。
 */
const ANSWER_KEY = "answer";

export interface JevClassifierOptions {
  /** null なら SDK が `TYPESAFE_API_KEY` を読む (未設定なら SDK が throw する)。 */
  apiKey: string | null;
  /** null なら SDK 既定の `jev-latest`。 */
  model: string | null;
  /** null なら SDK 既定の `https://api.typesafe.ai`。 */
  baseUrl: string | null;
  timeoutMs: number;
  /** 省略時は global fetch。SDK が用意しているテスト用の差し替え口。 */
  fetch?: Fetch;
}

/**
 * TypeSafe AI (Jev) を判定バックエンドにするアダプタ。
 *
 * これは Genius で唯一、カード内容がこのマシンの外へ出る経路なので、
 * `disclosure === "public"` 以外は呼び出し前に落とす。呼び出し元
 * (`DisclosureRoutedClassifier`) でも振り分けているが、将来この
 * アダプタを直接使われたときに黙って送出しないよう二重にしておく。
 */
export class JevClassifier implements Classifier {
  readonly #client: TypeSafeClient;

  constructor(options: JevClassifierOptions) {
    this.#client = new TypeSafeClient({
      timeout: options.timeoutMs,
      ...(options.apiKey === null ? {} : { apiKey: options.apiKey }),
      ...(options.model === null ? {} : { defaultModel: options.model }),
      ...(options.baseUrl === null ? {} : { baseURL: options.baseUrl }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  async noul(request: NoulRequest): Promise<NoulJudgment> {
    assertPublic(request.disclosure, request.purpose);
    const { answers } = await this.#client.systemOne({
      state: stateOf(request),
      questions: { [ANSWER_KEY]: noul(request.instructions, request.criteria ?? null) },
    });
    const probability = answers[ANSWER_KEY].noul;
    if (!isProbability(probability)) {
      throw new ClassificationError(`${request.purpose}: Jev returned a non-probability noul`);
    }
    return { yes: probability >= request.threshold, probability };
  }

  async choice(request: ChoiceRequest): Promise<ChoiceJudgment> {
    assertPublic(request.disclosure, request.purpose);
    const labels = Object.keys(request.labels);
    if (labels.length === 0) {
      throw new ClassificationError(`${request.purpose}: a choice needs at least one label`);
    }
    const { answers } = await this.#client.systemOne({
      state: stateOf(request),
      questions: { [ANSWER_KEY]: choice(request.instructions, { ...request.labels }) },
    });
    const answer = answers[ANSWER_KEY];
    // 語彙の外のラベルは呼び出し元 (category 列など) の制約を壊すので受け取らない。
    if (!labels.includes(answer.choice)) {
      throw new ClassificationError(`${request.purpose}: Jev chose a label outside the vocabulary`);
    }
    return { label: answer.choice, confidence: answer.confidence };
  }

}

/**
 * evidence は untrusted なので、指示 (instructions) とは別の `state` に置いて
 * 文字列化してから渡す。既存のテキスト LLM 経路と同じ本文を送る。
 */
function stateOf(request: NoulRequest | ChoiceRequest): string {
  return JSON.stringify(request.evidence);
}

function assertPublic(disclosure: string, purpose: string): void {
  if (disclosure === "public") return;
  throw new ClassificationError(
    `${purpose}: ${disclosure} evidence must not be sent to an external classifier`,
  );
}

function isProbability(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}
