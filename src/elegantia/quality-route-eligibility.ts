import type { CloneCard } from "../domain/card.js";
import { contract } from '../contract-runtime.js'; /* augur-inject:import:2cea253e */
import augurContract_b50c2073 from '../contracts/quality-route-eligibility.contract.js'; /* augur-inject:contract-predicate:b161470f */

/**
 * Elegantia へ判定・送信してよいカードか。
 *
 * Elegantia は公開読み取り面 (GET /api/antipatterns) を持つので、public 以外の
 * カードは判定 (外部判定バックエンドを含む) にも送信にも乗せない。supersede /
 * retire 済みのカードは Genius 上でも有効な判断ではないので送らない。
 */
export function qualityRouteEligible(
  card: Pick<CloneCard, "visibility" | "supersededBy" | "retiredAt">,
): boolean {
  return card.visibility === "public" && card.supersededBy === null && card.retiredAt === null;
}
// @ts-expect-error augur-inject
qualityRouteEligible = contract(qualityRouteEligible, { ...augurContract_b50c2073, contractId: 'C-10', mode: 'observe', sample: 1, where: 'src/elegantia/quality-route-eligibility.ts:10', rule: 'contract-wrap', id: 'b50c2073' }); /* augur-inject:contract-wrap:b50c2073 */
