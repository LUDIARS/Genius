import type { CloneCard } from "../domain/card.js";
import { contract } from '../contract-runtime.js'; /* augur-inject:import:e8eb59fe */
import augurContract_262a86fa from '../contracts/antipattern-payload.contract.js'; /* augur-inject:contract-predicate:465fd17d */

/** Elegantia の title 上限に依らず一覧で読める長さに揃える。 */
const MAX_TITLE_LENGTH = 120;

/** `POST /api/antipatterns` の body (Elegantia API 契約)。 */
export interface ElegantiaAntipatternInput {
  sourceRef: string;
  title: string;
  summary: string;
  detect: string[];
  fix: string;
  tags: string[];
  augur: null;
}

/** Elegantia 側の冪等キー。カード id だけで決まり、取り込み元の場所を含まない。 */
export function elegantiaSourceRef(cardId: string): string {
  return `genius:card:${cardId}`;
}

/**
 * 判断カードを Elegantia のアンチパターン項目へ写す。
 *
 * LLM で書き直さず決定的に写す: 送る文面は public 判定を通ったカード本文そのもの
 * に限り、新しい文面を生成して公開面へ出さない。カードの `sourceRef` は取り込み元
 * 文書の場所 (ローカルパス由来) なので載せない。計測指標 (augur) は Genius が
 * 推測で作らない — 指標を持つ項目は Elegantia のカタログ側で定義する。
 */
export function toElegantiaAntipattern(
  card: Pick<CloneCard, "id" | "sourceRef" | "situation" | "judgment" | "rationale" | "tags">,
): ElegantiaAntipatternInput {
  return {
    sourceRef: elegantiaSourceRef(card.id),
    title: truncate(firstLine(card.judgment), MAX_TITLE_LENGTH),
    summary: card.rationale,
    detect: [card.situation],
    fix: card.judgment,
    tags: [...card.tags],
    augur: null,
  };
}
// @ts-expect-error augur-inject
toElegantiaAntipattern = contract(toElegantiaAntipattern, { ...augurContract_262a86fa, contractId: 'C-9', mode: 'observe', sample: 1, where: 'src/elegantia/antipattern-payload.ts:30', rule: 'contract-wrap', id: '262a86fa' }); /* augur-inject:contract-wrap:262a86fa */

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}
