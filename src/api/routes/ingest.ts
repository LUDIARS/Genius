import type { Hono } from "hono";
import { z } from "zod";
import { TIER_TWO_SOURCES } from "../../config/types.js";
import { IngestValidationError } from "../../ingest/ingest-service.js";
import { sourceNameSchema } from "../../readers/source-reader.js";
import type { ApiServices } from "../contracts.js";
import { ApiInputError, parseOrThrow, readJsonOrThrow } from "../validation.js";

const ingestSchema = z
  .object({
    sources: z.array(sourceNameSchema).min(1).optional(),
    tier2: z.boolean().default(false),
    budgetFiles: z.number().int().positive().optional(),
    allowMissing: z.boolean().default(false),
    retryFailed: z.boolean().default(false),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.retryFailed && input.budgetFiles !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["budgetFiles"],
        message: "retryFailed does not accept budgetFiles",
      });
    }
    if (input.tier2 && !input.retryFailed && input.budgetFiles === undefined) {
      context.addIssue({
        code: "custom",
        path: ["budgetFiles"],
        message: "budgetFiles is required when tier2 is true",
      });
    }
    if (!input.tier2 && input.budgetFiles !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["budgetFiles"],
        message: "budgetFiles requires tier2=true",
      });
    }
    const requestedTierTwo = input.sources?.find((source) =>
      TIER_TWO_SOURCES.some((tierTwoSource) => tierTwoSource === source),
    );
    if (!input.tier2 && requestedTierTwo !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["sources"],
        message: `Tier 2 source requires tier2=true: ${requestedTierTwo}`,
      });
    }
  });

export function registerIngestRoutes(app: Hono, ingest: ApiServices["ingest"]): void {
  app.post("/api/clone/ingest/run", async (c) => {
    const options = parseOrThrow(ingestSchema, await readJsonOrThrow(c));
    let run: ReturnType<ApiServices["ingest"]["start"]>;
    try {
      run = ingest.start(options);
    } catch (error) {
      if (error instanceof IngestValidationError) throw new ApiInputError(error.message);
      throw error;
    }
    return c.json({ id: run.id, status: run.status }, 202);
  });

  app.get("/api/clone/ingest/runs/:id", (c) => {
    const run = ingest.status(c.req.param("id"));
    if (!run) return c.json({ error: "Ingest run not found" }, 404);
    // 「失敗を抱えたまま completed-with-errors が続いている」状態を run 照会で
    // 見えるようにする (spec/feature/operations.md §4)。
    return c.json({ ...run, unresolvedFailures: ingest.unresolvedFailures(run.sources) });
  });
}
