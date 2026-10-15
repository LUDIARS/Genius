import type { LoadedGeniusConfig } from "../config/types.js";
import type { GeniusDatabase } from "../db/database.js";
import type { CloneCard } from "../domain/card.js";
import { ConcordiaQuestionChannel } from "../questions/concordia-question-channel.js";
import { OutcomeFollowupRepository } from "./followup-repository.js";
import { OutcomeFollowupRelay } from "./outcome-followup-relay.js";
import type { CardOutcomeService } from "./outcome-service.js";

export interface CreateOutcomeFollowupRelayInputs {
  config: LoadedGeniusConfig;
  database: GeniusDatabase;
  cards: { getById(id: string): CloneCard | null };
  outcomes: CardOutcomeService;
  warningSink?: (message: string) => void;
  fetch?: typeof globalThis.fetch;
}

/**
 * 「結果は?」の配信経路を組み立てる (spec/feature/judgment-outcome.md §3.4)。
 * 無効化は許容するが無言にはしない — 補完質問と同じく理由を 1 行出す。
 *
 * @implements SPEC-GENIUS-OUTCOME-FOLLOWUP
 */
export function createOutcomeFollowupRelay(
  inputs: CreateOutcomeFollowupRelayInputs,
): OutcomeFollowupRelay | null {
  const { config } = inputs;
  const warn = inputs.warningSink ?? ((message: string) => process.stderr.write(`${message}\n`));
  if (!config.outcome.followupEnabled) {
    warn("[outcome] outcome follow-ups are disabled (outcome.followupEnabled is false)");
    return null;
  }
  if (!config.questions.discordEnabled) {
    warn("[outcome] outcome follow-ups are disabled (questions.discordEnabled is false)");
    return null;
  }
  if (config.notify.concordiaBaseUrl === null) {
    warn("[outcome] outcome follow-ups are disabled (notify.concordiaBaseUrl is null)");
    return null;
  }
  return new OutcomeFollowupRelay({
    channel: new ConcordiaQuestionChannel({
      baseUrl: config.notify.concordiaBaseUrl,
      ...(inputs.fetch === undefined ? {} : { fetch: inputs.fetch }),
    }),
    followups: new OutcomeFollowupRepository(inputs.database),
    cards: inputs.cards,
    outcomes: inputs.outcomes,
    delayDays: config.outcome.followupDelayDays,
    windowDays: config.outcome.followupWindowDays,
    maxPerRun: config.outcome.maxPerRun,
    deciderDiscordUserId: config.questions.deciderDiscordUserId,
    warningSink: warn,
  });
}
