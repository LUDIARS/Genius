import type { Classifier, Disclosure } from "../classify/classifier.js";
import type { GeniusDatabase } from "../db/database.js";
import { FALLBACK_CATEGORY, type CardCategory } from "../domain/category.js";

interface UncategorizedCardRow {
  id: string;
  situation: string;
  judgment: string;
  visibility: string;
}

export interface CategorizeBackfillOptions {
  categories: readonly CardCategory[];
  classifier: Classifier;
  database: GeniusDatabase;
  stdout: (text: string) => void;
}

export interface CategorizeBackfillResult {
  scanned: number;
  categorized: number;
  failed: number;
}

/**
 * Backfills clone_cards.category for cards distilled before the category
 * rollout. Classifies existing card text (situation + judgment); embeddings are
 * untouched, so no re-embedding happens (spec/feature/operations.md Section 1.2).
 *
 * visibility も読むのは、カード本文を外部の判定バックエンドへ出してよいのが
 * `public` のカードだけだから。実際の振り分けは Classifier 側が持つので、
 * ここは `disclosure` を正しく申告することだけに責任を持つ。
 */
export class CategorizeBackfillService {
  readonly #classifier: Classifier;
  readonly #database: GeniusDatabase;
  readonly #labels: Readonly<Record<string, string>>;
  readonly #stdout: (text: string) => void;

  constructor(options: CategorizeBackfillOptions) {
    if (options.categories.length === 0) {
      throw new Error("categorize requires a non-empty category vocabulary");
    }
    this.#classifier = options.classifier;
    this.#database = options.database;
    this.#labels = Object.fromEntries(
      options.categories.map((entry) => [entry.name, entry.description]),
    );
    this.#stdout = options.stdout;
  }

  async run(): Promise<CategorizeBackfillResult> {
    const rows = this.#database
      .prepare<[], UncategorizedCardRow>(
        "SELECT id, situation, judgment, visibility FROM clone_cards WHERE category IS NULL ORDER BY id ASC",
      )
      .all();
    this.#stdout(`[categorize] ${rows.length} card(s) without a category\n`);

    // updated_at is intentionally left unchanged: the backfill annotates
    // metadata, it does not edit card content.
    const update = this.#database.prepare(
      "UPDATE clone_cards SET category = ? WHERE id = ? AND category IS NULL",
    );
    const systemPrompt = this.#buildSystemPrompt();
    let categorized = 0;
    let failed = 0;
    for (const [index, row] of rows.entries()) {
      // 1 カードの失敗 (claude CLI timeout・statement 不正など) でプロセスごと
      // 死なせない (Memoria #736)。分類だけでなく UPDATE の失敗も同じ境界で
      // 隔離する。失敗カードは category NULL のまま残るので、次回の
      // categorize --missing が同じ SELECT で拾い直す。
      let category: string;
      let changes: number;
      try {
        const result = await this.#classifier.choice({
          purpose: "categorize",
          instructions: systemPrompt,
          labels: this.#labels,
          evidence: { situation: row.situation, judgment: row.judgment },
          disclosure: disclosureOf(row.visibility),
        });
        category = result.label;
        changes = update.run(category, row.id).changes;
      } catch (error) {
        failed += 1;
        const name = error instanceof Error ? error.name : "UnknownError";
        this.#stdout(
          `[categorize] ${index + 1}/${rows.length} ${row.id} failed (${name}); skipping\n`,
        );
        continue;
      }
      if (changes === 1) categorized += 1;
      this.#stdout(
        `[categorize] ${index + 1}/${rows.length} ${row.id} -> ${category}` +
          `${changes === 1 ? "" : " (skipped: categorized concurrently)"}\n`,
      );
    }
    this.#stdout(
      `[categorize] done: ${categorized}/${rows.length} card(s) categorized` +
        `${failed === 0 ? "" : `, ${failed} failed (left NULL for the next run)`}\n`,
    );
    return { scanned: rows.length, categorized, failed };
  }

  // 語彙そのものと出力形式の指示は Classifier 側が組み立てる (バックエンドごとに
  // 表現が違う) ので、ここは分類の意図だけを述べる。
  #buildSystemPrompt(): string {
    return [
      "Classify a judgment card into exactly one category of a controlled vocabulary.",
      `If no category clearly fits, use "${FALLBACK_CATEGORY}".`,
    ].join("\n");
  }
}

/** sensitive なカードはこのマシンの外の判定バックエンドへ渡さない。 */
function disclosureOf(visibility: string): Disclosure {
  return visibility === "public" ? "public" : "local-only";
}
