import { normalizeLoopbackHttpUrl } from "../config/loopback-url.js";
import { TIER_TWO_SOURCES } from "../config/types.js";
import type { SourceName } from "../readers/source-reader.js";
import type { IngestRunNotification, IngestRunNotifier } from "./ingest-contracts.js";

/** Concordia /v1/chat の text 上限 (PostSchema.text max 2000)。 */
const MAX_TEXT_LENGTH = 2000;
/** 通知本文へ載せる失敗明細の上限。残りは件数だけ知らせる。 */
const MAX_FAILURE_LINES = 5;
const MAX_FAILURE_MESSAGE_LENGTH = 120;

export interface ConcordiaRunNotifierOptions {
  /** loopback のみ許可 (genius.config.json notify.concordiaBaseUrl)。 */
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

export class ConcordiaNotifyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConcordiaNotifyError";
  }
}

/**
 * run が failed / completed-with-errors で終わったことを Concordia chat へ
 * POST する。経路は Concordia 側の正本 `POST /v1/chat` (確認箇所は README
 * 「Concordia 通知」節を参照)。payload は run id・ソース名・失敗件数・
 * エラー種別/メッセージ要約・ソース相対 locator のみで、文書本文・カード
 * 本文・絶対パスは載せない (spec/feature/operations.md §4)。
 */
export class ConcordiaRunNotifier implements IngestRunNotifier {
  readonly #chatUrl: URL;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: ConcordiaRunNotifierOptions) {
    const baseUrl = normalizeLoopbackHttpUrl(options.baseUrl, "notify.concordiaBaseUrl");
    this.#chatUrl = new URL("/v1/chat", baseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async notifyRunOutcome(notification: IngestRunNotification): Promise<void> {
    const body = {
      channel: "報告",
      author_label: "Genius",
      session_id: null,
      text: formatNotificationText(notification),
    };
    let response: Response;
    try {
      response = await this.#fetch(this.#chatUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
      });
    } catch (error) {
      throw new ConcordiaNotifyError(
        `Concordia notification failed to reach ${this.#chatUrl.pathname}`,
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new ConcordiaNotifyError(
        `Concordia notification was rejected with HTTP ${response.status}`,
      );
    }
  }
}

export function formatNotificationText(notification: IngestRunNotification): string {
  const lines: string[] = [
    `[genius] ingest run ${notification.runId} finished: ${notification.status}`,
    `sources: ${notification.sources.join(", ")}`,
    `failed documents: ${notification.failedDocuments} (unresolved total: ${notification.unresolvedFailures})`,
  ];
  if (notification.error !== null) {
    lines.push(`run error: ${notification.error}`);
  }
  // 質問生成の結果は 1 行だけ足す (spec/feature/active-questioning.md §5)。
  // 失敗明細より前に置いて MAX_TEXT_LENGTH の切り詰めで落ちないようにする。
  // @implements SPEC-GENIUS-ACTIVE-QUESTION-INGEST
  const questions = notification.questions ?? null;
  if (questions !== null) {
    lines.push(`questions: ${questions.created} generated (open: ${questions.openCount})`);
  }
  // 再処理コマンドは通知の実用部分なので、明細行より前に置いて
  // MAX_TEXT_LENGTH の切り詰めで落ちないようにする。
  lines.push(...retryHints(notification));
  for (const failure of notification.failures.slice(0, MAX_FAILURE_LINES)) {
    lines.push(
      `- ${failure.source}:${failure.locator} — ${failure.errorKind}: ${truncate(failure.errorMessage)}`,
    );
  }
  const remainder = notification.failures.length - MAX_FAILURE_LINES;
  if (remainder > 0) {
    lines.push(`… and ${remainder} more (see ingest_failures / logs/ingest.jsonl)`);
  }
  return truncateTo(lines.join("\n"), MAX_TEXT_LENGTH);
}

/**
 * 通知を受けた LLM がそのまま実行できる再処理コマンド (spec §4 の LLM
 * フォールバック)。--retry-failed は ingest_failures を入力にするため、
 * そこに記録された文書単位の失敗にだけ付ける。ソース単位の失敗
 * (listDocuments — spec §4「ソース単位の隔離」) と run 単位の失敗は
 * ingest_failures に無いので、通常の再実行を案内する (--retry-failed を
 * 付けると空振りする)。両方あるときは 2 行出す。
 */
function retryHints(notification: IngestRunNotification): string[] {
  if (notification.status === "completed") return [];
  const isolated = failedSources(notification, (scope) => scope !== "source");
  const sourceLevel = failedSources(notification, (scope) => scope === "source");
  if (isolated.length === 0 && sourceLevel.length === 0) {
    return [retryCommand([...notification.sources], false)];
  }
  return [
    ...(isolated.length > 0 ? [retryCommand(isolated, true)] : []),
    ...(sourceLevel.length > 0 ? [retryCommand(sourceLevel, false)] : []),
  ];
}

function failedSources(
  notification: IngestRunNotification,
  matches: (scope: "source" | "document") => boolean,
): SourceName[] {
  return [
    ...new Set(
      notification.failures
        .filter((failure) => matches(failure.scope ?? "document"))
        .map((failure) => failure.source),
    ),
  ];
}

function retryCommand(sources: readonly SourceName[], retryFailed: boolean): string {
  const tierTwo = sources.some((source) =>
    TIER_TWO_SOURCES.some((tierTwoSource) => tierTwoSource === source),
  );
  return [
    "retry: node dist/cli.js ingest",
    `--sources ${sources.join(",")}`,
    // Tier 2 ソースは --tier2 が無いと CLI/API の検証で落ちる。budget は未指定 =
    // 上限なしなので付けない — ここで --budget-files を足すと、再処理のつもりの
    // コマンドが黙って途中までしか読まなくなる (spec/feature/operations.md §6)。
    ...(tierTwo ? ["--tier2"] : []),
    ...(retryFailed ? ["--retry-failed"] : []),
  ].join(" ");
}

function truncate(message: string): string {
  return truncateTo(message, MAX_FAILURE_MESSAGE_LENGTH);
}

function truncateTo(text: string, maximum: number): string {
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}
