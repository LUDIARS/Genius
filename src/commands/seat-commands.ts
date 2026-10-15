import { parseArgs } from "node:util";
import { CardRepository } from "../cards/card-repository.js";
import { createClassifier } from "../classify/create-classifier.js";
import { openConfiguredDatabase } from "../db/database.js";
import { runMigrations } from "../db/migrate.js";
import { createDistillLlm } from "../distill/create-distill-llm.js";
import {
  judgmentSeatSchema,
  NO_SEAT_LABEL,
  seatProposalStatusSchema,
  type JudgmentSeat,
} from "../domain/seat.js";
import { SeatProposalService } from "../seats/seat-proposal-service.js";
import { SeatRepository } from "../seats/seat-repository.js";
import { optionalPositiveInteger, requiredOption, type CommandContext } from "./command-context.js";
import { requestJson } from "./request-json.js";

/**
 * `genius seats <propose|list|confirm|reject>` (spec/feature/judgment-outcome.md §4・§6)。
 * propose は categorize と同じく DB と判定バックエンドを直接使う大量 backfill 用。
 * list / confirm / reject は稼働中のサービスの HTTP API を叩く (確定は人間の操作)。
 */
export async function runSeatsCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<number> {
  const [verb, ...rest] = args;
  switch (verb) {
    case "propose":
      return runPropose(rest, context);
    case "list":
      return runList(rest, context);
    case "confirm":
      return runDecision(rest, context, "confirm");
    case "reject":
      return runDecision(rest, context, "reject");
    default:
      throw new Error("seats requires one of: propose, list, confirm, reject");
  }
}

async function runPropose(args: readonly string[], context: CommandContext): Promise<number> {
  const parsed = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: { limit: { type: "string" } },
  });
  const limit = optionalPositiveInteger(parsed.values.limit, "limit", 100);
  const database = openConfiguredDatabase(context.config);
  try {
    runMigrations(database);
    const llm = createDistillLlm(context.config);
    await llm.assertReady();
    const service = new SeatProposalService({
      seats: new SeatRepository(database),
      cards: new CardRepository(database),
      classifier: createClassifier(context.config, llm),
      stdout: context.stdout,
    });
    const result = await service.generate(limit);
    context.stdout(`${JSON.stringify({ ...result, coverage: service.coverage() }, null, 2)}\n`);
    // 全件失敗は backend 側の系統障害 (categorize と同じ判定)。
    return result.scanned > 0 && result.failed === result.scanned ? 1 : 0;
  } finally {
    database.close();
  }
}

async function runList(args: readonly string[], context: CommandContext): Promise<number> {
  const parsed = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: { status: { type: "string" }, limit: { type: "string" }, offset: { type: "string" } },
  });
  const url = new URL("/api/clone/seat-proposals", context.baseUrl);
  if (parsed.values.status !== undefined) {
    url.searchParams.set("status", seatProposalStatusSchema.parse(parsed.values.status));
  }
  if (parsed.values.limit !== undefined) url.searchParams.set("limit", parsed.values.limit);
  if (parsed.values.offset !== undefined) url.searchParams.set("offset", parsed.values.offset);
  const result = await requestJson(url, context.fetch, { method: "GET" });
  context.stdout(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

async function runDecision(
  args: readonly string[],
  context: CommandContext,
  action: "confirm" | "reject",
): Promise<number> {
  const parsed = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: { seat: { type: "string" }, by: { type: "string" } },
  });
  if (parsed.positionals.length !== 1) throw new Error(`seats ${action} requires exactly one <cardId>`);
  if (action === "reject" && parsed.values.seat !== undefined) {
    throw new Error("seats reject does not accept --seat");
  }
  const body = action === "reject"
    ? { action, decidedBy: requiredOption(parsed.values.by, "by") }
    : {
      action,
      decidedBy: requiredOption(parsed.values.by, "by"),
      ...(parsed.values.seat === undefined ? {} : { seat: parseSeatOption(parsed.values.seat) }),
    };
  const url = new URL(
    `/api/clone/seat-proposals/${encodeURIComponent(parsed.positionals[0]!)}/decision`,
    context.baseUrl,
  );
  const result = await requestJson(url, context.fetch, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  context.stdout(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

/** `none` は「どの席にも当たらない」として確定する。 */
function parseSeatOption(raw: string): JudgmentSeat | null {
  return raw === NO_SEAT_LABEL ? null : judgmentSeatSchema.parse(raw);
}
