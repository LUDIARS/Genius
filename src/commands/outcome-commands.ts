import { parseArgs } from "node:util";
import { CardRepository } from "../cards/card-repository.js";
import { openConfiguredDatabase } from "../db/database.js";
import { runMigrations } from "../db/migrate.js";
import { outcomeVerdictSchema } from "../domain/outcome.js";
import { judgmentSeatSchema } from "../domain/seat.js";
import { createOutcomeFollowupRelay } from "../outcome/create-outcome-followup-relay.js";
import { CardOutcomeRepository } from "../outcome/outcome-repository.js";
import { CardOutcomeService } from "../outcome/outcome-service.js";
import { requiredOption, type CommandContext } from "./command-context.js";
import { requestJson } from "./request-json.js";

/**
 * `genius outcome <set|get|stats|followup>` (spec/feature/judgment-outcome.md §6)。
 * set / get / stats は稼働中のサービスの HTTP API を叩く。followup だけは
 * ingest を待たずに手で 1 回回すための経路で、DB と Concordia を直接使う。
 */
export async function runOutcomeCommand(
  args: readonly string[],
  context: CommandContext,
): Promise<number> {
  const [verb, ...rest] = args;
  switch (verb) {
    case "set":
      return runSet(rest, context);
    case "get":
      return runGet(rest, context);
    case "stats":
      return runStats(rest, context);
    case "followup":
      return runFollowup(rest, context);
    default:
      throw new Error("outcome requires one of: set, get, stats, followup");
  }
}

async function runSet(args: readonly string[], context: CommandContext): Promise<number> {
  const parsed = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      verdict: { type: "string" },
      adopted: { type: "string" },
      result: { type: "string" },
      by: { type: "string" },
    },
  });
  if (parsed.positionals.length !== 1) throw new Error("outcome set requires exactly one <cardId>");
  const body = {
    verdict: outcomeVerdictSchema.parse(requiredOption(parsed.values.verdict, "verdict")),
    adoptedDecision: requiredOption(parsed.values.adopted, "adopted"),
    actualResult: requiredOption(parsed.values.result, "result"),
    recordedBy: requiredOption(parsed.values.by, "by"),
    via: "cli",
  };
  const result = await requestJson(cardOutcomeUrl(context, parsed.positionals[0]!), context.fetch, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  context.stdout(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

async function runGet(args: readonly string[], context: CommandContext): Promise<number> {
  if (args.length !== 1) throw new Error("outcome get requires exactly one <cardId>");
  const result = await requestJson(cardOutcomeUrl(context, args[0]!), context.fetch, {
    method: "GET",
  });
  context.stdout(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

async function runStats(args: readonly string[], context: CommandContext): Promise<number> {
  const parsed = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: { seat: { type: "string" }, from: { type: "string" }, to: { type: "string" } },
  });
  const url = new URL("/api/clone/stats/outcome", context.baseUrl);
  if (parsed.values.seat !== undefined) {
    url.searchParams.set("seat", judgmentSeatSchema.parse(parsed.values.seat));
  }
  if (parsed.values.from !== undefined) url.searchParams.set("from", parsed.values.from);
  if (parsed.values.to !== undefined) url.searchParams.set("to", parsed.values.to);
  const result = await requestJson(url, context.fetch, { method: "GET" });
  context.stdout(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

async function runFollowup(args: readonly string[], context: CommandContext): Promise<number> {
  if (args.length !== 0) throw new Error("outcome followup does not accept arguments");
  const database = openConfiguredDatabase(context.config);
  try {
    runMigrations(database);
    const cards = new CardRepository(database);
    const relay = createOutcomeFollowupRelay({
      config: context.config,
      database,
      cards,
      outcomes: new CardOutcomeService(cards, new CardOutcomeRepository(database)),
      fetch: context.fetch,
      warningSink: (message) => context.stdout(`${message}\n`),
    });
    // 無効化の理由は createOutcomeFollowupRelay が 1 行出している。手で回した結果が
    // 「何もしなかった」なら成功扱いにしない。
    if (relay === null) return 1;
    const result = await relay.run();
    context.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } finally {
    database.close();
  }
}

function cardOutcomeUrl(context: CommandContext, cardId: string): URL {
  return new URL(`/api/clone/cards/${encodeURIComponent(cardId)}/outcome`, context.baseUrl);
}
