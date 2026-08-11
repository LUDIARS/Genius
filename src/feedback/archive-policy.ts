import {
  judgedFeedbackCount,
  type CardFeedbackSummary,
} from "../domain/feedback.js";

/**
 * 「poor が多いカードをアーカイブする」規則そのもの
 * (spec/feature/card-feedback.md §4)。
 *
 * 副作用も I/O も持たない純関数として切り出す。閾値の妥当性はここのテストだけで
 * 確かめられるようにし、記録経路 (feedback-service) と混ぜない。
 */
export interface ArchiveThresholds {
  /** これ未満の poor 件数では落とさない。 */
  minimumPoor: number;
  /** poor / (great + good + poor) がこの値以上なら落とす。 */
  poorRatio: number;
}

export const DEFAULT_ARCHIVE_THRESHOLDS: ArchiveThresholds = {
  // 蒸留カードは場面依存なので、たまたま合わなかった 1 回では落とさない。
  minimumPoor: 3,
  poorRatio: 0.6,
};

/** @implements SPEC-GENIUS-CARD-FEEDBACK-ARCHIVE */
export function assertArchiveThresholds(thresholds: ArchiveThresholds): void {
  if (!Number.isSafeInteger(thresholds.minimumPoor) || thresholds.minimumPoor < 1) {
    throw new Error("feedback.minimumPoor must be an integer >= 1");
  }
  if (
    !Number.isFinite(thresholds.poorRatio)
    || thresholds.poorRatio <= 0
    || thresholds.poorRatio > 1
  ) {
    throw new Error("feedback.poorRatio must be a number in (0, 1]");
  }
}

/**
 * この集計がアーカイブ条件を満たすか。`not-in-case` は分子にも分母にも入らない
 * ため、`not-in-case` だけがいくら積まれても false のままになる。
 *
 * @implements SPEC-GENIUS-CARD-FEEDBACK-ARCHIVE
 */
export function shouldArchive(
  summary: CardFeedbackSummary,
  thresholds: ArchiveThresholds = DEFAULT_ARCHIVE_THRESHOLDS,
): boolean {
  assertArchiveThresholds(thresholds);
  if (summary.poor < thresholds.minimumPoor) return false;
  const judged = judgedFeedbackCount(summary);
  if (judged === 0) return false;
  return summary.poor / judged >= thresholds.poorRatio;
}
