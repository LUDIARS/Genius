import type { CloneCard } from "../domain/card.js";

/**
 * 頻出カードグループのキャッシュ (spec/feature/operations.md §10)。
 *
 * 「カードグループ」= ある絞り込み条件が選ぶカードの並び (一覧 1 ページ分)。
 * 同じ条件が繰り返し引かれる形 — WebUI の再表示、ページ送りの往復、決まった
 * カテゴリを見に来る運用ジョブ — が実際の負荷なので、そこだけを覚える。
 *
 * 設計上の約束を 3 つ置く:
 *
 * 1. **一度目は覚えない**。`hotThreshold` 回引かれて初めて保存する。1 回きりの
 *    条件まで保存すると、探索的な絞り込みでメモリを食うだけで当たらない。
 * 2. **カードが変わったら全部捨てる**。repository 内の書き込み回数と SQLite の
 *    `data_version` を組み合わせた現在版を持ち、値が変われば全 entry を捨てる。
 *    後者により、別プロセスの categorize のような外部接続からの更新も検知する。
 * 3. **返す配列は複製**。呼び出し側が並べ替えても保存物が壊れないようにする。
 *
 * @implements SPEC-GENIUS-CARD-GROUP-CACHE
 */
export interface CardGroupCacheOptions {
  /** この回数だけ引かれた条件を「頻出」とみなす (既定 2 = 2 回目から覚える)。 */
  hotThreshold?: number;
  /** 保存結果と頻度記録の上限。超えたらそれぞれ最も古く使われたものから捨てる。 */
  maxEntries?: number;
}

interface CacheEntry {
  cards: CloneCard[];
}

const DEFAULT_HOT_THRESHOLD = 2;
const DEFAULT_MAX_ENTRIES = 64;

export class CardGroupCache {
  readonly #hotThreshold: number;
  readonly #maxEntries: number;
  /** 条件ごとの参照回数。入力種類数によるメモリ増加を防ぐため LRU 上限を持つ。 */
  readonly #requests = new Map<string, number>();
  /** Map の挿入順を LRU として使う (get のたびに入れ直す)。 */
  readonly #entries = new Map<string, CacheEntry>();
  #version: string | null = null;

  constructor(options: CardGroupCacheOptions = {}) {
    this.#hotThreshold = options.hotThreshold ?? DEFAULT_HOT_THRESHOLD;
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isSafeInteger(this.#hotThreshold) || this.#hotThreshold < 1) {
      throw new Error("cardGroupCache.hotThreshold must be an integer >= 1");
    }
    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries < 1) {
      throw new Error("cardGroupCache.maxEntries must be an integer >= 1");
    }
  }

  /**
   * 参照を 1 回数え、保存済みで版が一致していればそれを返す。
   * 呼び出し側は miss のときだけ DB を読み、結果を `remember` に渡す。
   */
  get(key: string, version: string): CloneCard[] | null {
    this.#useVersion(version);
    const requestCount = (this.#requests.get(key) ?? 0) + 1;
    // 参照回数側も LRU にする。q を含む一度きりの条件を永続的に保持しない。
    this.#requests.delete(key);
    this.#requests.set(key, requestCount);
    while (this.#requests.size > this.#maxEntries) {
      const oldest = this.#requests.keys().next();
      if (oldest.done === true) break;
      this.#requests.delete(oldest.value);
    }
    const entry = this.#entries.get(key);
    if (entry === undefined) return null;
    // LRU: 使ったものを末尾へ送り直す。
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return [...entry.cards];
  }

  /** 頻出条件になっていれば保存する。まだなら何もしない。 */
  remember(key: string, version: string, cards: readonly CloneCard[]): void {
    this.#useVersion(version);
    if ((this.#requests.get(key) ?? 0) < this.#hotThreshold) return;
    this.#entries.delete(key);
    this.#entries.set(key, { cards: [...cards] });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
  }

  #useVersion(version: string): void {
    if (this.#version !== null && this.#version !== version) {
      // 旧版のカード内容を、未アクセスのグループも含めて保持し続けない。
      this.#entries.clear();
    }
    this.#version = version;
  }
}
