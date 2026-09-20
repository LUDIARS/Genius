import type {
  ChoiceJudgment,
  ChoiceRequest,
  Classifier,
  NoulJudgment,
  NoulRequest,
} from "./classifier.js";

export interface DisclosureRoutedClassifierOptions {
  /** このマシンの外で動く判定バックエンド。`public` の判定だけを渡す。 */
  external: Classifier;
  /** ローカル判定。`local-only` の行き先であり、external 失敗時の退避先。 */
  local: Classifier;
  warningSink?: (message: string) => void;
}

/**
 * 送出可否で判定先を振り分ける唯一の場所。
 *
 * ここが Genius の外向き境界なので、「どの判定を外へ出すか」の規則を
 * 呼び出し元へ散らさない。`local-only` は external を一度も呼ばない。
 * external が失敗したときはローカルへ退避する — 外部サービスの不調で
 * 分類そのものが止まらないようにするため。
 */
export class DisclosureRoutedClassifier implements Classifier {
  readonly #external: Classifier;
  readonly #local: Classifier;
  readonly #warningSink: (message: string) => void;

  constructor(options: DisclosureRoutedClassifierOptions) {
    this.#external = options.external;
    this.#local = options.local;
    this.#warningSink =
      options.warningSink ?? ((message) => process.stderr.write(`${message}\n`));
  }

  noul(request: NoulRequest): Promise<NoulJudgment> {
    return this.#route(
      request.disclosure,
      request.purpose,
      () => this.#external.noul(request),
      () => this.#local.noul(request),
    );
  }

  choice(request: ChoiceRequest): Promise<ChoiceJudgment> {
    return this.#route(
      request.disclosure,
      request.purpose,
      () => this.#external.choice(request),
      () => this.#local.choice(request),
    );
  }

  async #route<T>(
    disclosure: string,
    purpose: string,
    external: () => Promise<T>,
    local: () => Promise<T>,
  ): Promise<T> {
    if (disclosure !== "public") return local();
    try {
      return await external();
    } catch (error) {
      // 判定対象もバックエンドの応答本文も載せない (エラー名のみ) —
      // 外部送出の失敗ログからカード内容が漏れないようにするため。
      const name = error instanceof Error ? error.name : "UnknownError";
      this.#warningSink(`[classify] ${purpose}: external classifier failed (${name}); using local`);
      return local();
    }
  }
}
