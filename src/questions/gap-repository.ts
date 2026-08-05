import { activeCardClause } from "../cards/active-card-sql.js";
import { CLONE_CARD_COLUMNS, mapCloneCardRow, type CloneCardRow } from "../cards/card-row.js";
import type { GeniusDatabase } from "../db/database.js";
import type { CloneCard } from "../domain/card.js";
import { FALLBACK_CATEGORY } from "../domain/category.js";
import type { GapEvidence } from "./types.js";

interface QueryMissRow {
  id: string;
  text: string;
  domain: "work" | "hobby" | null;
  visibility: "public" | "sensitive" | null;
  categories: string | null;
  top_similarity: number | null;
  result_count: number;
}

interface CategoryCountRow {
  name: string;
  count: number;
}

interface CurationRow extends CloneCardRow {
  changed_at: number;
}

/**
 * Q3 の gap 検出クエリ (spec/feature/active-questioning.md §1)。
 * 統制語彙の正本は `card_categories` テーブルで、ここには複製を持たない。
 */
export class GapRepository {
  readonly #database: GeniusDatabase;
  readonly #hasCategory: (name: string) => boolean;

  constructor(database: GeniusDatabase) {
    this.#database = database;
    // 起動時のスナップショットをキャッシュすると、実行中に追加された
    // カテゴリーのカードが無言で general に落ちる。都度 card_categories を引く。
    const knownCategory = database.prepare<[string], { one: number }>(
      "SELECT 1 AS one FROM card_categories WHERE name = ? LIMIT 1",
    );
    this.#hasCategory = (name) => knownCategory.get(name) !== undefined;
    if (!this.#hasCategory(FALLBACK_CATEGORY)) {
      throw new Error(`Controlled category vocabulary must contain ${FALLBACK_CATEGORY}`);
    }
  }

  listLowConfidence(threshold: number, limit: number): GapEvidence[] {
    assertThreshold(threshold, "low-confidence threshold");
    assertLimit(limit);
    const rows = this.#database
      .prepare<[number, number], CloneCardRow>(
        `SELECT ${CLONE_CARD_COLUMNS} FROM clone_cards
          WHERE ${activeCardClause()} AND confidence < ?
            AND NOT EXISTS (
              SELECT 1 FROM question_targets AS targets
               WHERE targets.target_kind = 'card' AND targets.target_id = clone_cards.id
            )
          ORDER BY confidence ASC, updated_at DESC, id ASC LIMIT ?`,
      )
      .all(threshold, limit);
    return rows.map((row) => this.#cardGap("low-confidence", mapCloneCardRow(row), {
      confidence: row.confidence,
    }));
  }

  listRetrievalMisses(threshold: number, limit: number): GapEvidence[] {
    assertThreshold(threshold, "retrieval-miss threshold");
    assertLimit(limit);
    const rows = this.#database
      .prepare<[number, number], QueryMissRow>(
        `SELECT id, text, domain, visibility, categories, top_similarity, result_count
           FROM query_log
          WHERE (result_count = 0 OR top_similarity IS NULL OR top_similarity < ?)
            AND NOT EXISTS (
              SELECT 1 FROM question_targets AS targets
               WHERE targets.target_kind = 'query_log' AND targets.target_id = query_log.id
            )
          ORDER BY CASE WHEN result_count = 0 THEN 0 ELSE 1 END,
                   top_similarity ASC, created_at DESC, id ASC
          LIMIT ?`,
      )
      .all(threshold, limit);
    return rows.map((row) => {
      const categories = parseCategories(row.categories);
      return {
        gapKind: "retrieval-miss",
        domain: row.domain ?? "work",
        // Missing visibility is ambiguous; keep the question inside the local boundary.
        visibility: row.visibility ?? "sensitive",
        category: categories.length === 1 && this.#hasCategory(categories[0] ?? "")
          ? categories[0]!
          : FALLBACK_CATEGORY,
        primaryTarget: { kind: "query_log", id: row.id },
        targets: [{ kind: "query_log", id: row.id }],
        promptEvidence: {
          query: row.text,
          domain: row.domain,
          visibility: row.visibility,
          categories,
          topSimilarity: row.top_similarity,
          resultCount: row.result_count,
        },
      } satisfies GapEvidence;
    });
  }

  listCuration(limit: number): GapEvidence[] {
    assertLimit(limit);
    const columns = CLONE_CARD_COLUMNS.split(",")
      .map((column) => `cards.${column.trim()}`)
      .join(", ");
    const rows = this.#database
      .prepare<[number], CurationRow>(
        `SELECT ${columns}, max(revisions.changed_at) AS changed_at
           FROM clone_card_revisions AS revisions
           JOIN clone_cards AS cards ON cards.id = revisions.card_id
          WHERE NOT EXISTS (
            SELECT 1 FROM question_targets AS targets
             WHERE targets.target_kind = 'card' AND targets.target_id = cards.id
          ) AND ((
            cards.retired_at IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM json_each(revisions.changed_fields) WHERE value = 'retired_at'
            )
          ) OR (
            cards.visibility = 'sensitive'
            AND EXISTS (
              SELECT 1 FROM json_each(revisions.changed_fields) WHERE value = 'visibility'
            )
          ))
          GROUP BY cards.id
          ORDER BY changed_at DESC, cards.id ASC
          LIMIT ?`,
      )
      .all(limit);
    return rows.map((row) => this.#cardGap("curation", mapCloneCardRow(row), {
      changedAt: row.changed_at,
      retired: row.retired_at !== null,
      visibility: row.visibility,
    }));
  }

  listCategoryGaps(limit: number): GapEvidence[] {
    assertLimit(limit);
    const rows = this.#database
      .prepare<[], CategoryCountRow>(
        `SELECT categories.name, count(cards.id) AS count
           FROM card_categories AS categories
           LEFT JOIN clone_cards AS cards
             ON cards.category = categories.name AND ${activeCardClause("cards")}
          WHERE NOT EXISTS (
            SELECT 1 FROM question_targets AS targets
             WHERE targets.target_kind = 'category' AND targets.target_id = categories.name
          )
          GROUP BY categories.name
          ORDER BY count ASC, categories.name ASC`,
      )
      .all();
    if (rows.length === 0) return [];
    const sortedCounts = rows.map((row) => row.count).sort((left, right) => left - right);
    const median = sortedCounts[Math.floor(sortedCounts.length / 2)] ?? 0;
    return rows
      .filter((row) => row.count === 0 || row.count < median)
      .slice(0, limit)
      .map((row) => ({
        gapKind: "category-gap",
        domain: "work",
        // Category-only evidence has no source quadrant; sensitive is the safe default.
        visibility: "sensitive",
        category: row.name,
        primaryTarget: { kind: "category", id: row.name },
        targets: [{ kind: "category", id: row.name }],
        promptEvidence: { category: row.name, activeCardCount: row.count, medianActiveCount: median },
      }));
  }

  listActiveCards(): CloneCard[] {
    return this.#database
      .prepare<[], CloneCardRow>(
        `SELECT ${CLONE_CARD_COLUMNS} FROM clone_cards
          WHERE ${activeCardClause()} ORDER BY id ASC`,
      )
      .all()
      .map(mapCloneCardRow);
  }

  #cardGap(
    gapKind: "low-confidence" | "curation",
    card: CloneCard,
    signal: Record<string, unknown>,
  ): GapEvidence {
    return {
      gapKind,
      domain: card.domain,
      visibility: card.visibility,
      category: this.#category(card.category),
      primaryTarget: { kind: "card", id: card.id },
      targets: [{ kind: "card", id: card.id }],
      promptEvidence: { card: publicCardEvidence(card), signal },
    };
  }

  #category(category: string | null): string {
    return category !== null && this.#hasCategory(category) ? category : FALLBACK_CATEGORY;
  }
}

export function publicCardEvidence(card: CloneCard): Record<string, unknown> {
  return {
    id: card.id,
    domain: card.domain,
    visibility: card.visibility,
    category: card.category,
    situation: card.situation,
    judgment: card.judgment,
    rationale: card.rationale,
    tags: card.tags,
    confidence: card.confidence,
  };
}

function parseCategories(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  } catch {
    // Corrupt measurement rows are treated as unscoped rather than leaking raw JSON to errors.
  }
  return [];
}

function assertThreshold(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`${name} must be between 0 and 1`);
  }
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("gap limit must be positive");
}
