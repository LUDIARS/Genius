import { describe, expect, it } from "vitest";

import {
  MemoriaReader,
  type FetchImplementation,
} from "../../src/readers/memoria-reader.js";
import { SourceReaderError } from "../../src/readers/reader-error.js";

describe("MemoriaReader", () => {
  it("lists diary, notes, and tasks using GET only and reads their content", async () => {
    const requests: Array<{
      url: string;
      method: string | undefined;
      redirect: RequestRedirect | undefined;
      hasSignal: boolean;
    }> = [];
    const fetchImplementation: FetchImplementation = async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method,
        redirect: init?.redirect,
        hasSignal: init?.signal !== undefined && init.signal !== null,
      });
      const { pathname, search } = new URL(url);
      const endpoint = `${pathname}${search}`;
      switch (endpoint) {
        case "/api/diary?month=2026-07":
          return jsonResponse({
            month: "2026-07",
            items: [{ date: "2026-07-01", updated_at: "2026-07-01T01:00:00.000Z" }],
          });
        case "/api/notes?limit=200&offset=0":
          return jsonResponse({
            items: [{
              id: "note-1",
              title: "Reader note",
              updated_at: "2026-07-02T01:00:00.000Z",
            }],
            total: 1,
          });
        case "/api/tasks?limit=200&offset=0&kind=all":
          return jsonResponse({
            items: [{
              id: 7,
              title: "Reader task",
              details: "Keep the integration read-only.",
              updated_at: "2026-07-03T01:00:00.000Z",
            }],
          });
        case "/api/diary/2026-07-01":
          return jsonResponse({
            date: "2026-07-01",
            summary: "Used explicit failure for malformed input.",
          });
        case "/api/notes/note-1":
          return jsonResponse({
            id: "note-1",
            title: "Reader note",
            blocks: [{ text: "Stream large transcript files." }],
          });
        default:
          return jsonResponse({ error: "unexpected endpoint" }, 404);
      }
    };
    const reader = new MemoriaReader(
      "http://127.0.0.1:5180",
      fetchImplementation,
      {
        diaryHistoryStartMonth: "2026-07",
        now: () => new Date(2026, 6, 17),
      },
    );

    const batch = await reader.listDocuments(null);
    expect(batch.documents.map((descriptor) => descriptor.locator)).toEqual([
      "diary/2026-07-01",
      "notes/note-1",
      "tasks/7",
    ]);

    const documents = await Promise.all(
      batch.documents.map((descriptor) => reader.readDocument(descriptor)),
    );
    expect(documents[0]?.content).toContain("explicit failure");
    expect(documents[1]?.content).toContain("Stream large transcript files");
    expect(documents[2]?.content).toContain("Keep the integration read-only");
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    expect(requests.every((request) => request.redirect === "error" && request.hasSignal)).toBe(true);
    expect(requests.some((request) => request.url.includes("/api/tasks/7"))).toBe(false);
  });

  it("enumerates diary history across months and detects a late edit through the cursor", async () => {
    let juneUpdatedAt = "2026-06-15T01:00:00.000Z";
    const requestedMonths: string[] = [];
    const fetchImplementation: FetchImplementation = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/diary") {
        const month = url.searchParams.get("month");
        if (month === null) return jsonResponse({ error: "month is required" }, 400);
        requestedMonths.push(month);
        if (month === "2026-06") {
          return jsonResponse({
            month,
            items: [{ date: "2026-06-15", updated_at: juneUpdatedAt }],
          });
        }
        if (month === "2026-07") {
          return jsonResponse({
            month,
            items: [{ date: "2026-07-02", updated_at: "2026-07-02T01:00:00.000Z" }],
          });
        }
        return jsonResponse({ error: "unexpected month" }, 404);
      }
      if (url.pathname === "/api/notes") {
        return jsonResponse({ items: [], total: 0 });
      }
      if (url.pathname === "/api/tasks") {
        return jsonResponse({ items: [] });
      }
      return jsonResponse({ error: "unexpected endpoint" }, 404);
    };
    const reader = new MemoriaReader(
      "http://127.0.0.1:5180",
      fetchImplementation,
      {
        diaryHistoryStartMonth: "2026-06",
        now: () => new Date(2026, 6, 17),
      },
    );

    const initial = await reader.listDocuments(null);
    expect(initial.documents.map((descriptor) => descriptor.locator)).toEqual([
      "diary/2026-06-15",
      "diary/2026-07-02",
    ]);
    expect(initial.nextCursor).not.toBeNull();
    expect(requestedMonths).toEqual(["2026-06", "2026-07"]);

    juneUpdatedAt = "2026-07-03T01:00:00.000Z";
    requestedMonths.length = 0;
    const incremental = await reader.listDocuments(initial.nextCursor);

    expect(incremental.documents.map((descriptor) => descriptor.locator)).toEqual([
      "diary/2026-06-15",
    ]);
    expect(incremental.nextCursor?.locator).toBe("diary/2026-06-15");
    expect(requestedMonths).toEqual(["2026-06", "2026-07"]);
  });

  it("fails explicitly for HTTP errors and malformed list responses", async () => {
    const unavailable = new MemoriaReader(
      "http://127.0.0.1:5180",
      async () => new Response("unavailable", { status: 503 }),
    );
    await expect(unavailable.listDocuments(null)).rejects.toBeInstanceOf(SourceReaderError);

    const malformed = new MemoriaReader(
      "http://127.0.0.1:5180",
      async () => jsonResponse({ items: "not-an-array" }),
    );
    await expect(malformed.listDocuments(null)).rejects.toThrow("diary response");
  });

  it("rejects external URLs and times out stalled requests", async () => {
    expect(() => new MemoriaReader("https://memoria.invalid")).toThrow(/loopback host/);

    const stalled = new MemoriaReader(
      "http://127.0.0.1:5180",
      async (_input, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error("test fetch expected an abort signal");
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
      { timeoutMs: 10 },
    );
    await expect(stalled.listDocuments(null)).rejects.toThrow(/Memoria GET failed/);
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
