import type { HealthStatus } from "../api/contracts.js";
import type { EmbeddingClient } from "../embedding/types.js";
import { CardService } from "./card-service.js";

export class HealthService {
  readonly #cards: CardService;
  readonly #embedder: EmbeddingClient;

  constructor(cards: CardService, embedder: EmbeddingClient) {
    this.#cards = cards;
    this.#embedder = embedder;
  }

  async get(): Promise<HealthStatus> {
    let ollama = true;
    try {
      await this.#embedder.assertReady();
    } catch (error) {
      ollama = false;
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[health] Ollama unavailable: ${detail}\n`);
    }
    return {
      ok: ollama,
      model: this.#embedder.model,
      cards: this.#cards.count(),
      ollama,
    };
  }
}
