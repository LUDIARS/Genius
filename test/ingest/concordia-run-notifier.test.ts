import { describe, expect, it, vi } from "vitest";
import {
  ConcordiaNotifyError,
  ConcordiaRunNotifier,
  formatNotificationText,
} from "../../src/ingest/concordia-run-notifier.js";
import type { IngestRunNotification } from "../../src/ingest/ingest-contracts.js";

function notification(overrides: Partial<IngestRunNotification> = {}): IngestRunNotification {
  return {
    runId: "run-1",
    status: "completed-with-errors",
    sources: ["memory", "review"],
    failedDocuments: 1,
    unresolvedFailures: 2,
    failures: [
      {
        source: "memory",
        locator: "notes/decision.md",
        errorKind: "source-read-failed",
        errorMessage: "[memory] cannot read source",
      },
    ],
    error: null,
    ...overrides,
  };
}

describe("ConcordiaRunNotifier", () => {
  it("posts the run outcome to the Concordia chat endpoint", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return Response.json({ message: { id: 1 } });
    });
    const notifier = new ConcordiaRunNotifier({
      baseUrl: "http://127.0.0.1:14500",
      fetch: fetchMock as typeof fetch,
    });

    await notifier.notifyRunOutcome(notification());

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://127.0.0.1:14500/v1/chat");
    expect(requests[0]?.body).toMatchObject({
      channel: "報告",
      author_label: "Genius",
      session_id: null,
    });
    const text = String(requests[0]?.body.text);
    expect(text).toContain("run-1");
    expect(text).toContain("completed-with-errors");
    expect(text).toContain("memory:notes/decision.md");
    expect(text).toContain("--retry-failed");
    expect(text.length).toBeLessThanOrEqual(2000);
  });

  it("keeps the text within the Concordia limit and caps failure detail lines", () => {
    const failures = Array.from({ length: 40 }, (_, index) => ({
      source: "memory" as const,
      locator: `deep/path/document-${index}.md`,
      errorKind: "processing-failed" as const,
      errorMessage: "x".repeat(300),
    }));
    const text = formatNotificationText(notification({ failures, failedDocuments: 40 }));

    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toContain("… and 35 more");

    // 明細が長くても、実際に叩ける再処理コマンドは切り詰めで落ちない。
    const longLocators = formatNotificationText(notification({
      failures: failures.map((failure, index) => ({
        ...failure,
        locator: `${"deep/".repeat(120)}document-${index}.md`,
      })),
      failedDocuments: 40,
    }));
    expect(longLocators.length).toBeLessThanOrEqual(2000);
    expect(longLocators).toContain("--retry-failed");
  });

  it("suggests a retry command that the CLI actually accepts", () => {
    const cleanWithQuestions = formatNotificationText(notification({
      status: "completed",
      failedDocuments: 0,
      unresolvedFailures: 0,
      failures: [],
      questions: { created: 2, openCount: 4 },
    }));
    expect(cleanWithQuestions).toContain("questions: 2 generated (open: 4)");
    expect(cleanWithQuestions).not.toContain("retry:");

    // 失敗した文書のソースだけを載せる (失敗の無いソースを retry させない)。
    const scoped = formatNotificationText(notification());
    expect(scoped).toContain("--sources memory --retry-failed");

    // Tier 2 ソースは --tier2 が無いと CLI 検証で落ちる。
    const tierTwo = formatNotificationText(notification({
      sources: ["claude-jsonl"],
      failures: [
        {
          source: "claude-jsonl",
          locator: "project/session.jsonl",
          errorKind: "processing-failed",
          errorMessage: "Error",
        },
      ],
    }));
    expect(tierTwo).toContain("--sources claude-jsonl --tier2 --retry-failed");

    // 文書単位の隔離が無い run 単位の失敗では --retry-failed は空振りする。
    const runLevel = formatNotificationText(notification({
      status: "failed",
      sources: ["memory"],
      failures: [],
      failedDocuments: 0,
      error: "Ingest failed: source-read-failed; source=memory",
    }));
    expect(runLevel).toContain("--sources memory");
    expect(runLevel).not.toContain("--retry-failed");

    // ソース単位の失敗 (listDocuments) は ingest_failures に記録されないので
    // --retry-failed では拾えない。通常の再実行を案内する。
    const sourceLevel = formatNotificationText(notification({
      sources: ["memory", "review"],
      failures: [
        {
          source: "review",
          locator: "<listDocuments>",
          errorKind: "source-read-failed",
          errorMessage: "[review] cannot read latest.json",
          scope: "source",
        },
      ],
    }));
    expect(sourceLevel).toContain("--sources review");
    expect(sourceLevel).not.toContain("--retry-failed");

    // 文書単位とソース単位が混在する run は両方の再処理を案内する。
    const mixed = formatNotificationText(notification({
      sources: ["memory", "review"],
      failures: [
        {
          source: "memory",
          locator: "notes/decision.md",
          errorKind: "processing-failed",
          errorMessage: "Error",
          scope: "document",
        },
        {
          source: "review",
          locator: "<listDocuments>",
          errorKind: "source-read-failed",
          errorMessage: "[review] cannot read latest.json",
          scope: "source",
        },
      ],
    }));
    expect(mixed).toContain("--sources memory --retry-failed");
    expect(mixed).toContain("--sources review\n");

    // run 単位の Tier 2 失敗でも budget は付けない。未指定 = 上限なしなので、
    // ここで上限を足すと再処理が黙って途中までで終わる
    // (spec/feature/operations.md §6)。
    const tierTwoRunLevel = formatNotificationText(notification({
      status: "failed",
      sources: ["claude-jsonl"],
      failures: [],
      failedDocuments: 0,
      error: "Ingest failed: source-read-failed; source=claude-jsonl",
    }));
    expect(tierTwoRunLevel).toContain("--sources claude-jsonl --tier2");
    expect(tierTwoRunLevel).not.toContain("--budget-files");
  });

  it("fails fast on an unreachable endpoint and on a rejected response", async () => {
    const unreachable = new ConcordiaRunNotifier({
      baseUrl: "http://127.0.0.1:14500",
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
    });
    await expect(unreachable.notifyRunOutcome(notification())).rejects.toThrowError(
      ConcordiaNotifyError,
    );

    const rejected = new ConcordiaRunNotifier({
      baseUrl: "http://127.0.0.1:14500",
      fetch: (async () => Response.json({ error: "bad" }, { status: 400 })) as typeof fetch,
    });
    await expect(rejected.notifyRunOutcome(notification())).rejects.toThrowError(/HTTP 400/);
  });

  it("rejects a non-loopback Concordia base URL at construction", () => {
    expect(
      () => new ConcordiaRunNotifier({ baseUrl: "https://concordia.invalid" }),
    ).toThrowError(/loopback/);
  });
});
