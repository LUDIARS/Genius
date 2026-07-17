export interface EmbeddingClient {
  readonly model: string;
  readonly dimension: number;
  assertReady(): Promise<void>;
  embed(texts: readonly string[]): Promise<number[][]>;
}

export interface ActiveEmbeddingModel {
  model: string;
  dimension: number;
}

export class EmbeddingError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EmbeddingError";
  }
}
