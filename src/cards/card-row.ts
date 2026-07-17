import type { CloneCard } from "../domain/card.js";

export interface CloneCardRow {
  id: string;
  domain: "work" | "hobby";
  visibility: "public" | "sensitive";
  situation: string;
  judgment: string;
  rationale: string;
  tags: string;
  source_ref: string;
  source_tier: 1 | 2;
  confidence: number;
  superseded_by: string | null;
  created_at: number;
  updated_at: number;
}

function parseTags(value: string, cardId: string): string[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch (error) {
    throw new Error(`Card ${cardId} has invalid tags JSON`, { cause: error });
  }
  if (
    !Array.isArray(decoded) ||
    decoded.some((tag) => typeof tag !== "string" || tag.trim() === "")
  ) {
    throw new Error(`Card ${cardId} tags must be a non-empty-string array`);
  }
  return decoded;
}

export function mapCloneCardRow(row: CloneCardRow): CloneCard {
  return {
    id: row.id,
    domain: row.domain,
    visibility: row.visibility,
    situation: row.situation,
    judgment: row.judgment,
    rationale: row.rationale,
    tags: parseTags(row.tags, row.id),
    sourceRef: row.source_ref,
    sourceTier: row.source_tier,
    confidence: row.confidence,
    supersededBy: row.superseded_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const CLONE_CARD_COLUMNS = `
  id,
  domain,
  visibility,
  situation,
  judgment,
  rationale,
  tags,
  source_ref,
  source_tier,
  confidence,
  superseded_by,
  created_at,
  updated_at
`;
