import type {
  CardChangeOrigin,
  CardDomain,
  CardPatch,
  CardVisibility,
  CloneCard,
  DistilledCard,
  ScoredCloneCard,
} from "../domain/card.js";
import type {
  CardFeedbackEntry,
  CardFeedbackSummary,
  RecordCardFeedbackInput,
} from "../domain/feedback.js";
import type { RecordFeedbackResult } from "../feedback/feedback-service.js";
import type { CardSortField, CardSortOrder } from "../cards/card-repository.js";
import type { SupersedeChain } from "../cards/supersede-chain.js";
import type { CardCategory, CreateCategoryInput } from "../domain/category.js";
import type { IngestOptions, IngestRunRecord } from "../ingest/ingest-contracts.js";
import type { SourceName } from "../readers/source-reader.js";

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
  /** OR filter over controlled-vocabulary categories. Unset = all categories. */
  categories?: string[];
  k: number;
}

export interface QueryResult {
  cards: ScoredCloneCard[];
  tookMs: number;
}

export interface ListCardsInput {
  domain?: CardDomain;
  visibility?: CardVisibility;
  category?: string;
  tag?: string;
  q?: string;
  limit: number;
  offset: number;
  /** Superseded cards are hidden unless the caller asks for them. */
  includeSuperseded: boolean;
  /** Retired cards are hidden unless the caller asks for them. */
  includeRetired: boolean;
  sort: CardSortField;
  order: CardSortOrder;
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
  /** Cards retired without a replacement (`retired_at IS NOT NULL`). */
  retired: number;
  /** Cards that are neither superseded nor retired — what query and export see. */
  active: number;
  total: number;
  /** ingest_failures の resolved_at IS NULL 件数 (取りこぼしの可視化)。 */
  unresolvedIngestFailures: number;
}

export interface PublicExportCard {
  id: string;
  domain: CardDomain;
  visibility: "public";
  category: string | null;
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
  query: {
    query(input: QueryInput): Promise<QueryResult>;
    /** Batches embedding for several queries into a single round trip. */
    queryMany(inputs: readonly QueryInput[]): Promise<QueryResult[]>;
  };
  cards: {
    list(input: ListCardsInput): Promise<CloneCard[]>;
    get(id: string): Promise<CloneCard | null>;
    create(input: ManualCardInput): Promise<CloneCard>;
    patch(id: string, patch: CardPatch, changedBy: CardChangeOrigin): Promise<CloneCard | null>;
    /** Retirement history around a card, or `null` when the card is unknown. */
    supersedeChain(id: string): Promise<SupersedeChain | null>;
  };
  categories: {
    list(): Promise<CardCategory[]>;
    create(input: CreateCategoryInput): Promise<CardCategory>;
    /** Returns the input names that are outside the controlled vocabulary. */
    findUnknown(names: readonly string[]): Promise<string[]>;
  };
  ingest: {
    start(options: IngestOptions): IngestRunRecord;
    status(id: string): IngestRunRecord | null;
    unresolvedFailures(sources?: readonly SourceName[]): number;
  };
  stats: {
    get(): Promise<CloneStats>;
    exportPublic(category?: string): Promise<PublicExportCard[]>;
  };
  /** カード評価 (spec/feature/card-feedback.md)。 */
  feedback: {
    record(
      cardId: string,
      input: RecordCardFeedbackInput,
      options?: { publicOnly?: boolean },
    ): RecordFeedbackResult;
    summary(cardId: string): CardFeedbackSummary;
    summaries(cardIds: readonly string[]): Map<string, CardFeedbackSummary>;
    recent(cardId: string, limit?: number): CardFeedbackEntry[];
    isArchivedByFeedback(cardId: string): boolean;
  };
}
