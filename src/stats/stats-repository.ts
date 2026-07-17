import type Database from "better-sqlite3";
import type { CloneStats, PublicExportCard } from "../api/contracts.js";
import type { CardDomain, CardVisibility } from "../domain/card.js";

interface CountRow {
  count: number;
}

interface QuadrantRow extends CountRow {
  domain: CardDomain;
  visibility: CardVisibility;
}

interface TierRow extends CountRow {
  source_tier: 1 | 2;
}

interface LastIngestRow {
  last_ingest_at: number | null;
}

interface ExportRow {
  id: string;
  domain: CardDomain;
  visibility: "public";
  situation: string;
  judgment: string;
  rationale: string;
  tags: string;
  source_tier: 1 | 2;
  confidence: number;
  created_at: number;
  updated_at: number;
}

export class StatsRepository {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  async get(): Promise<CloneStats> {
    const quadrants: CloneStats["quadrants"] = {
      "work:public": 0,
      "work:sensitive": 0,
      "hobby:public": 0,
      "hobby:sensitive": 0,
    };
    for (const row of this.#database
      .prepare("SELECT domain, visibility, COUNT(*) AS count FROM clone_cards GROUP BY domain, visibility")
      .all() as QuadrantRow[]) {
      quadrants[`${row.domain}:${row.visibility}`] = row.count;
    }

    const tiers: CloneStats["tiers"] = { "1": 0, "2": 0 };
    for (const row of this.#database
      .prepare("SELECT source_tier, COUNT(*) AS count FROM clone_cards GROUP BY source_tier")
      .all() as TierRow[]) {
      tiers[String(row.source_tier) as "1" | "2"] = row.count;
    }

    const lastIngest = this.#database
      .prepare("SELECT MAX(finished_at) AS last_ingest_at FROM distill_runs")
      .get() as LastIngestRow;
    const superseded = this.#count("SELECT COUNT(*) AS count FROM clone_cards WHERE superseded_by IS NOT NULL");
    const total = this.#count("SELECT COUNT(*) AS count FROM clone_cards");
    return {
      quadrants,
      tiers,
      lastIngestAt: lastIngest.last_ingest_at,
      superseded,
      total,
    };
  }

  async exportPublic(): Promise<PublicExportCard[]> {
    const rows = this.#database
      .prepare(
        `SELECT id, domain, visibility, situation, judgment, rationale, tags,
                source_tier, confidence, created_at, updated_at
           FROM clone_cards
          WHERE visibility = 'public' AND superseded_by IS NULL
          ORDER BY created_at ASC, id ASC`,
      )
      .all() as ExportRow[];
    return rows.map((row) => ({
      id: row.id,
      domain: row.domain,
      visibility: row.visibility,
      situation: row.situation,
      judgment: row.judgment,
      rationale: row.rationale,
      tags: parseTags(row.tags, row.id),
      sourceTier: row.source_tier,
      confidence: row.confidence,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  #count(sql: string): number {
    return (this.#database.prepare(sql).get() as CountRow).count;
  }
}

function parseTags(raw: string, cardId: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((tag) => typeof tag === "string")) {
    throw new Error(`Card ${cardId} contains invalid tags JSON`);
  }
  return parsed;
}
