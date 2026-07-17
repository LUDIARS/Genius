import type {
  CardDomain,
  CardPatch,
  CardVisibility,
  CloneCard,
  DistilledCard,
  ScoredCloneCard,
} from "../domain/card.js";
import type { IngestOptions, IngestRunRecord } from "../ingest/ingest-contracts.js";

export interface HealthStatus {
  ok: boolean;
  model: string;
  cards: number;
  ollama: boolean;
}

export interface QueryInput {
  text: string;
  domain?: CardDomain;
  visibility?: CardVisibility;
  k: number;
}

export interface QueryResult {
  cards: ScoredCloneCard[];
  tookMs: number;
}

export interface ListCardsInput {
  domain?: CardDomain;
  visibility?: CardVisibility;
  tag?: string;
  q?: string;
  limit: number;
  offset: number;
}

export interface ManualCardInput extends DistilledCard {
  sourceRef?: string;
  sourceTier?: 1 | 2;
}

export interface CloneStats {
  quadrants: Record<`${CardDomain}:${CardVisibility}`, number>;
  tiers: Record<"1" | "2", number>;
  lastIngestAt: number | null;
  superseded: number;
  total: number;
}

export interface PublicExportCard {
  id: string;
  domain: CardDomain;
  visibility: "public";
  situation: string;
  judgment: string;
  rationale: string;
  tags: string[];
  sourceTier: 1 | 2;
  confidence: number;
  createdAt: number;
  updatedAt: number;
}

export interface ApiServices {
  health: { get(): Promise<HealthStatus> };
  query: { query(input: QueryInput): Promise<QueryResult> };
  cards: {
    list(input: ListCardsInput): Promise<CloneCard[]>;
    get(id: string): Promise<CloneCard | null>;
    create(input: ManualCardInput): Promise<CloneCard>;
    patch(id: string, patch: CardPatch): Promise<CloneCard | null>;
  };
  ingest: {
    start(options: IngestOptions): IngestRunRecord;
    status(id: string): IngestRunRecord | null;
  };
  stats: {
    get(): Promise<CloneStats>;
    exportPublic(): Promise<PublicExportCard[]>;
  };
}
