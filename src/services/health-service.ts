import type { HealthStatus, ReadinessStatus } from "../api/contracts.js";
import type { EmbeddingClient } from "../embedding/types.js";
import { CardService } from "./card-service.js";

/**
 * 死活と準備状態を分ける (spec/feature/operations.md §9)。
 *
 * `/healthz` は **フロントワーカー (この HTTP プロセス) が生きているか**だけを答える。
 * カードも Ollama も見ない。理由は測定結果:
 * 依存確認込みの `/healthz` は実測 0.79〜1.02 秒かかる一方、Excubitor の probe 予算は
 * 1 秒 (`src/scanner/health.ts` の既定) なので、健全なのに 3 回に 1 回 timeout し、
 * 監視画面上は落ちて見えていた (2026-08-12 実測: 24 時間で 19 incidents)。
 * 依存の遅さを生存判定に混ぜると、生きているサービスを落ちていると報告する。
 *
 * 依存込みの判定が要る呼び出し元には `/readyz` を用意する。こちらは従来どおり
 * Ollama 疎通とカード件数を返し、埋め込みが使えなければ 503 になる。
 *
 * @implements SPEC-GENIUS-HEALTH-READINESS
 * @implements SPEC-GENIUS-BUILD-FRESHNESS
 */
export class HealthService {
  readonly #cards: CardService;
  readonly #embedder: EmbeddingClient;
  /** 起動時に一度だけ評価した `dist/` の鮮度判定 (SPEC-GENIUS-BUILD-FRESHNESS)。 */
  readonly #buildStale: boolean;

  /** @implements SPEC-GENIUS-BUILD-FRESHNESS */
  constructor(cards: CardService, embedder: EmbeddingClient, buildStale: boolean) {
    this.#cards = cards;
    this.#embedder = embedder;
    this.#buildStale = buildStale;
  }

  /**
   * 生存確認。I/O を一切行わないので、応答時間はイベントループの空き具合そのもの。
   * これが返らないときは「フロントワーカーが応答不能」であり、まさに知りたい状態。
   */
  get(): HealthStatus {
    return { ok: true };
  }

  /**
   * 準備確認。埋め込みバックエンドとカード件数まで見る (呼ばれたときだけ)。
   * @implements SPEC-GENIUS-BUILD-FRESHNESS
   */
  async ready(): Promise<ReadinessStatus> {
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
      buildStale: this.#buildStale,
    };
  }
}
