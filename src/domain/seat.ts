import { z } from "zod";
import { decisionAuthorSchema } from "./card.js";

/**
 * 判断の「席」(MUSA 処理設計 §7 の 9 席、spec/feature/judgment-outcome.md §4)。
 *
 * 統制語彙の TypeScript 側の正本。DB の CHECK 制約 (migration 011) はここから
 * 組み立てるので、席を足すときはここだけを変える。
 * §7-D で 2 (スクラムマスター) と 6 (現場ディレクション) は `team` に統合済み。
 */
export const JUDGMENT_SEATS = [
  "quality",
  "team",
  "pm",
  "adjuster",
  "engagement",
  "po",
  "ad",
  "architecture",
  "devops",
] as const;

export const judgmentSeatSchema = z.enum(JUDGMENT_SEATS);

export type JudgmentSeat = z.infer<typeof judgmentSeatSchema>;

/**
 * 各席が答える 1 つの問い (§7-B の「問い」)。分類の提案に使う説明文で、
 * 判定バックエンドへはこの文だけを渡す (席の内部事情は渡さない)。
 */
export const JUDGMENT_SEAT_QUESTIONS: Readonly<Record<JudgmentSeat, string>> = {
  quality: "品質 (QA / 審美眼 / 表現判定): これは出せる品質か (ship / fix-first / reject、表現レーティング)",
  team: "チームを回す (課題整理 / スプリント / 割当 / 成果物の受入 / 判断の学習): 何が詰まっていて、誰に何を作らせ、出来たものを通すか",
  pm: "PM (スケジュール / コスト / 枠内に納める): いつまでに、いくらで、何を削れば枠に納まるか",
  adjuster: "アジャスター (アセット / 文言 / 設定の選択): この相手・この場面には、候補のどれが適切か",
  engagement: "エンゲージメント / KPI 予測 (継続 / 未来予測): ユーザーは続けるか、どこで離れるか、次に何が起きるか",
  po: "PO / プロデューサー (事業判断 / 事業リスク): この企画を続けるか、枠をいくらにするか、出して事業上の問題はないか",
  ad: "広告 / 宣伝 (獲得): 誰に、何を、どう伝えて獲得するか",
  architecture: "アーキテクチャ + 物語 (どう作るか): この設計で行くか、既存を使うか、負債をいつ返すか、物語の構造は一貫しているか",
  devops: "DevOps / 運営 (出荷 / ロールバック / インシデント): 今出すか、戻すか、止めるか",
};

/**
 * 提案だけが使う「どの席にも当たらない」ラベル。席ではないので
 * `JUDGMENT_SEATS` には入れず、保存時は `seat = NULL` として持つ。
 */
export const NO_SEAT_LABEL = "none";

export const SEAT_PROPOSAL_STATUSES = ["proposed", "confirmed", "rejected"] as const;

export const seatProposalStatusSchema = z.enum(SEAT_PROPOSAL_STATUSES);

export type SeatProposalStatus = z.infer<typeof seatProposalStatusSchema>;

/** 席の提案 1 件。確定は人間が行う (§4)。 */
export interface SeatProposal {
  cardId: string;
  /** null = 「どの席にも当たらない」という提案。 */
  proposedSeat: JudgmentSeat | null;
  /** 判定バックエンドの確信度 (0〜1)。テキスト LLM は 1 固定。 */
  confidence: number;
  status: SeatProposalStatus;
  /** 人間が確定した席。null のまま confirmed = 「席なし」を人間が認めた。 */
  decidedSeat: JudgmentSeat | null;
  decidedBy: string | null;
  decidedAt: number | null;
  createdAt: number;
}

/** カードに付いている (人間が確定した) 席。 */
export interface CardSeat {
  cardId: string;
  seat: JudgmentSeat;
  confirmedBy: string;
  confirmedAt: number;
}

/** 人間の確定操作。`seat` を渡すと提案と違う席で確定できる。 */
export const seatDecisionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("confirm"),
    seat: judgmentSeatSchema.nullable().optional(),
    decidedBy: decisionAuthorSchema,
  }).strict(),
  z.object({
    action: z.literal("reject"),
    decidedBy: decisionAuthorSchema,
  }).strict(),
]);

export type SeatDecision = z.infer<typeof seatDecisionSchema>;
