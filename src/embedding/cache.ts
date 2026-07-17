import { createHash } from "node:crypto";
import type { GeniusDatabase } from "../db/database.js";
import { EmbeddingError, type EmbeddingClient } from "./types.js";
import { decodeVector, encodeVector, validateVector } from "./vector-codec.js";

interface EmbeddingCacheRow {
  embedding: Buffer;
}

/** Bump whenever text preprocessing or binary vector encoding changes. */
export const EMBEDDING_CACHE_FORMAT_VERSION = 1;

export interface EmbeddingCacheOptions {
  clock?: () => number;
}

export interface EmbeddingCacheWrite {
  text: string;
  vector: readonly number[];
}

export function embeddingTextHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export class EmbeddingCache {
  readonly #database: GeniusDatabase;
  readonly #clock: () => number;

  public constructor(database: GeniusDatabase, options: EmbeddingCacheOptions = {}) {
    this.#database = database;
    this.#clock = options.clock ?? Date.now;
  }

  public get(model: string, dimension: number, text: string): number[] | null {
    const row = this.#database
      .prepare<[string, number, number, string], EmbeddingCacheRow>(
        `SELECT embedding FROM embedding_cache
         WHERE model = ? AND dim = ? AND format_version = ? AND text_sha256 = ?`,
      )
      .get(model, dimension, EMBEDDING_CACHE_FORMAT_VERSION, embeddingTextHash(text));
    return row === undefined ? null : decodeVector(row.embedding, dimension);
  }

  public require(model: string, dimension: number, text: string): number[] {
    const vector = this.get(model, dimension, text);
    if (vector === null) {
      throw new EmbeddingError(
        `Embedding cache miss for precomputed text using model ${model}`,
      );
    }
    return vector;
  }

  public set(model: string, dimension: number, text: string, vector: readonly number[]): void {
    this.setMany(model, dimension, [{ text, vector }]);
  }

  public setMany(
    model: string,
    dimension: number,
    entries: readonly EmbeddingCacheWrite[],
  ): void {
    if (entries.length === 0) return;
    for (const [index, entry] of entries.entries()) {
      validateVector(entry.vector, dimension, `cache write ${index}`);
    }
    const statement = this.#database.prepare(
      `INSERT INTO embedding_cache(
         model, dim, format_version, text_sha256, embedding, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(model, dim, format_version, text_sha256) DO UPDATE SET
         embedding = excluded.embedding,
         created_at = excluded.created_at`,
    );
    const createdAt = this.#clock();
    this.#database.transaction(() => {
      for (const entry of entries) {
        statement.run(
          model,
          dimension,
          EMBEDDING_CACHE_FORMAT_VERSION,
          embeddingTextHash(entry.text),
          encodeVector(entry.vector, dimension),
          createdAt,
        );
      }
    })();
  }
}

export class CachedEmbeddingClient implements EmbeddingClient {
  readonly #inner: EmbeddingClient;
  readonly #cache: EmbeddingCache;
  public readonly model: string;
  public readonly dimension: number;

  public constructor(inner: EmbeddingClient, cache: EmbeddingCache) {
    this.#inner = inner;
    this.#cache = cache;
    this.model = inner.model;
    this.dimension = inner.dimension;
  }

  public assertReady(): Promise<void> {
    return this.#inner.assertReady();
  }

  public async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const vectorsByText = new Map<string, number[]>();
    const misses: string[] = [];
    const missingTexts = new Set<string>();
    for (const text of texts) {
      if (vectorsByText.has(text) || missingTexts.has(text)) continue;
      const cached = this.#cache.get(this.model, this.dimension, text);
      if (cached === null) {
        misses.push(text);
        missingTexts.add(text);
      }
      else vectorsByText.set(text, cached);
    }

    if (misses.length > 0) {
      const fresh = await this.#inner.embed(misses);
      if (fresh.length !== misses.length) {
        throw new EmbeddingError(
          `Embedding client returned ${fresh.length} vectors for ${misses.length} cache misses`,
        );
      }
      const writes: EmbeddingCacheWrite[] = [];
      for (let index = 0; index < misses.length; index += 1) {
        const text = misses[index]!;
        const vector = fresh[index]!;
        validateVector(vector, this.dimension, `embedding ${index}`);
        writes.push({ text, vector });
        vectorsByText.set(text, vector);
      }
      this.#cache.setMany(this.model, this.dimension, writes);
    }

    return texts.map((text) => {
      const vector = vectorsByText.get(text);
      if (vector === undefined) {
        throw new EmbeddingError("Embedding cache failed to preserve input order");
      }
      return vector;
    });
  }
}
