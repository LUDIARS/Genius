import { z } from "zod";
import { sourceNameSchema } from "../readers/source-reader.js";

/**
 * `GET /api/clone/ingest/runs/:id` の応答契約。
 *
 * status は "completed-with-errors" を含む 4 値 union。polling 側は
 * 「completed 以外は失敗」と判定してはならず、`isIngestRunSuccessful` を
 * 使う (spec/feature/operations.md §4)。
 */
export const ingestRunStatusSchema = z.enum([
  "running",
  "completed",
  "completed-with-errors",
  "failed",
]);

export type IngestRunStatusValue = z.infer<typeof ingestRunStatusSchema>;

export const ingestRunViewSchema = z.object({
  id: z.string().min(1),
  sources: z.array(sourceNameSchema),
  status: ingestRunStatusSchema,
  filesProcessed: z.number().int().nonnegative(),
  cardsCreated: z.number().int().nonnegative(),
  cardsMerged: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failedDocuments: z.number().int().nonnegative(),
  // Elegantia 登録の件数 (spec/feature/elegantia-route.md §5)。連携導入前の
  // サーバは返さないので省略は null として読む。
  elegantia: z
    .object({
      registered: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    })
    .nullable()
    .default(null),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  error: z.string().nullable(),
  unresolvedFailures: z.number().int().nonnegative(),
});

export type IngestRunView = z.infer<typeof ingestRunViewSchema>;

/** run が終了したか (成功・失敗を問わない)。 */
export function isIngestRunFinished(status: IngestRunStatusValue): boolean {
  return status !== "running";
}

/** run を正常終了として扱ってよいか。completed-with-errors も正常終了扱い。 */
export function isIngestRunSuccessful(status: IngestRunStatusValue): boolean {
  return status === "completed" || status === "completed-with-errors";
}
