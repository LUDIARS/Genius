import { createTierOneBatch } from "./batch.js";
import { normalizeLoopbackHttpUrl } from "../config/loopback-url.js";
import { SourceReaderError } from "./reader-error.js";
import {
  sourceRefFor,
  type ListDocumentsOptions,
  type ReaderCursor,
  type SourceDocument,
  type SourceDocumentBatch,
  type SourceDocumentDescriptor,
  type SourceReader,
} from "./source-reader.js";

const PAGE_SIZE = 200;
const MAX_API_PAGES = 10_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_DIARY_HISTORY_START_MONTH = "1970-01";

export type FetchImplementation = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;

export interface MemoriaReaderOptions {
  /** Inclusive history boundary. Runtime uses the Unix epoch; tests may shorten it. */
  diaryHistoryStartMonth?: string;
  now?: () => Date;
  timeoutMs?: number;
}

export class MemoriaReader implements SourceReader {
  public readonly source = "memoria" as const;
  public readonly tier = 1 as const;
  private readonly baseUrl: string;
  private readonly diaryHistoryStartMonth: string;
  private readonly fetchImplementation: FetchImplementation;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly listedPayloads = new Map<string, Readonly<Record<string, unknown>>>();

  public constructor(
    baseUrl: string,
    fetchImplementation: FetchImplementation = globalThis.fetch,
    options: MemoriaReaderOptions = {},
  ) {
    this.baseUrl = normalizeLoopbackHttpUrl(baseUrl, "Memoria baseUrl");
    this.fetchImplementation = fetchImplementation;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("Memoria timeoutMs must be a positive integer");
    }
    this.diaryHistoryStartMonth = requireMonth(
      options.diaryHistoryStartMonth ?? DEFAULT_DIARY_HISTORY_START_MONTH,
      "Memoria diaryHistoryStartMonth",
    );
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = timeoutMs;
  }

  public async listDocuments(
    cursor: ReaderCursor | null,
    _options?: ListDocumentsOptions,
  ): Promise<SourceDocumentBatch> {
    this.listedPayloads.clear();
    const descriptors = [
      ...await this.listDiaryDescriptors(),
      ...await this.listPaginatedDescriptors("notes"),
      ...await this.listPaginatedDescriptors("tasks"),
    ];
    const seen = new Set<string>();
    for (const descriptor of descriptors) {
      if (seen.has(descriptor.locator)) {
        throw new SourceReaderError(
          this.source,
          `Memoria returned a duplicate resource: ${descriptor.locator}`,
          { locator: descriptor.locator },
        );
      }
      seen.add(descriptor.locator);
    }
    return createTierOneBatch(this.source, descriptors, cursor);
  }

  public async readDocument(
    descriptor: SourceDocumentDescriptor,
  ): Promise<SourceDocument> {
    this.assertDescriptor(descriptor);
    const endpoint = descriptor.nativeId;
    if (endpoint === undefined) {
      throw new SourceReaderError(this.source, "descriptor has an invalid Memoria endpoint", {
        locator: descriptor.locator,
      });
    }
    const payload = endpoint.startsWith("cache:")
      ? this.readCachedPayload(endpoint, descriptor.locator)
      : await this.readDetailEndpoint(endpoint, descriptor.locator);
    if (!isRecord(payload)) {
      throw new SourceReaderError(this.source, "Memoria detail response must be an object", {
        locator: descriptor.locator,
      });
    }
    return {
      descriptor,
      sourceRef: sourceRefFor(descriptor),
      title: documentTitle(payload, descriptor.locator),
      content: JSON.stringify(payload, null, 2),
      metadata: { resource: descriptor.locator.split("/")[0] ?? "unknown" },
    };
  }

  private async listDiaryDescriptors(): Promise<readonly SourceDocumentDescriptor[]> {
    const currentMonth = monthFromDate(this.now(), "Memoria current date");
    const months = enumerateMonths(this.diaryHistoryStartMonth, currentMonth);
    const descriptors: SourceDocumentDescriptor[] = [];

    // Memoria exposes only a month-scoped diary listing and no complete
    // modification index. Enumerating every representable month is necessary
    // to notice a late edit to an old diary; createTierOneBatch still prevents
    // unchanged documents from being read or distilled again.
    for (const month of months) {
      const payload = await this.getJson(`/api/diary?month=${month}`);
      if (!isRecord(payload)) {
        throw new SourceReaderError(
          this.source,
          `Memoria diary response for ${month} must be an object`,
        );
      }
      if (payload.month !== month) {
        throw new SourceReaderError(
          this.source,
          `Memoria diary response month mismatch for ${month}`,
        );
      }
      if (!Array.isArray(payload.items)) {
        throw new SourceReaderError(
          this.source,
          `Memoria diary response for ${month} must contain an items array`,
        );
      }
      for (let index = 0; index < payload.items.length; index += 1) {
        const record = requireRecord(
          this.source,
          payload.items[index],
          `diary item ${index} for ${month}`,
        );
        const date = requireResourceId(
          this.source,
          record.date,
          `diary item ${index} for ${month}`,
        );
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !date.startsWith(`${month}-`)) {
          throw new SourceReaderError(
            this.source,
            `diary item ${index} for ${month} has an invalid date`,
          );
        }
        descriptors.push({
          source: this.source,
          tier: this.tier,
          locator: `diary/${date}`,
          mtimeMs: timestampFromRecord(this.source, record, date),
          nativeId: `/api/diary/${encodeURIComponent(date)}`,
        });
      }
    }
    return descriptors;
  }

  private async listPaginatedDescriptors(
    resource: "notes" | "tasks",
  ): Promise<readonly SourceDocumentDescriptor[]> {
    const descriptors: SourceDocumentDescriptor[] = [];
    const seenIds = new Set<string>();
    let offset = 0;

    for (let page = 0; page < MAX_API_PAGES; page += 1) {
      const kind = resource === "tasks" ? "&kind=all" : "";
      const payload = await this.getJson(
        `/api/${resource}?limit=${PAGE_SIZE}&offset=${offset}${kind}`,
      );
      if (!isRecord(payload) || !Array.isArray(payload.items)) {
        throw new SourceReaderError(
          this.source,
          `Memoria ${resource} response must contain an items array`,
        );
      }
      for (let index = 0; index < payload.items.length; index += 1) {
        const item = requireRecord(this.source, payload.items[index], `${resource} item ${index}`);
        const id = requireResourceId(this.source, item.id, `${resource} item ${index}`);
        if (seenIds.has(id)) {
          throw new SourceReaderError(
            this.source,
            `Memoria ${resource} pagination repeated id ${id}`,
          );
        }
        seenIds.add(id);
        const locator = `${resource}/${encodeURIComponent(id)}`;
        const nativeId = resource === "tasks"
          ? `cache:${locator}`
          : `/api/${resource}/${encodeURIComponent(id)}`;
        if (resource === "tasks") {
          this.listedPayloads.set(nativeId, item);
        }
        descriptors.push({
          source: this.source,
          tier: this.tier,
          locator,
          mtimeMs: timestampFromRecord(this.source, item),
          nativeId,
        });
      }

      offset += payload.items.length;
      const total = payload.total;
      if (typeof total === "number" && Number.isFinite(total) && offset >= total) {
        return descriptors;
      }
      if (payload.items.length < PAGE_SIZE) {
        return descriptors;
      }
    }

    throw new SourceReaderError(
      this.source,
      `Memoria ${resource} pagination exceeded ${MAX_API_PAGES} pages`,
    );
  }

  private async getJson(endpoint: string): Promise<unknown> {
    const url = `${this.baseUrl}${endpoint}`;
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new SourceReaderError(this.source, `Memoria GET failed: ${endpoint}`, {
        cause: error,
      });
    }
    if (!response.ok) {
      throw new SourceReaderError(
        this.source,
        `Memoria GET ${endpoint} returned HTTP ${response.status}`,
      );
    }
    try {
      return await response.json();
    } catch (error) {
      throw new SourceReaderError(
        this.source,
        `Memoria GET ${endpoint} returned malformed JSON`,
        { cause: error },
      );
    }
  }

  private async readDetailEndpoint(endpoint: string, locator: string): Promise<unknown> {
    if (!isAllowedDetailEndpoint(endpoint)) {
      throw new SourceReaderError(this.source, "descriptor has an invalid Memoria endpoint", {
        locator,
      });
    }
    return this.getJson(endpoint);
  }

  private readCachedPayload(
    cacheKey: string,
    locator: string,
  ): Readonly<Record<string, unknown>> {
    const payload = this.listedPayloads.get(cacheKey);
    if (payload === undefined) {
      throw new SourceReaderError(
        this.source,
        "Memoria task descriptor must be read by the reader instance that listed it",
        { locator },
      );
    }
    return payload;
  }

  private assertDescriptor(descriptor: SourceDocumentDescriptor): void {
    if (descriptor.source !== this.source || descriptor.tier !== this.tier) {
      throw new SourceReaderError(this.source, "descriptor belongs to another reader", {
        locator: descriptor.locator,
      });
    }
  }
}

function timestampFromRecord(
  source: "memoria",
  record: Readonly<Record<string, unknown>>,
  fallbackDate?: string,
): number {
  const value = record.updated_at ?? record.created_at ?? fallbackDate;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value.length === 10 ? `${value}T00:00:00.000Z` : value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  throw new SourceReaderError(source, "Memoria resource has no valid update timestamp");
}

function requireMonth(value: string, label: string): string {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)) {
    throw new TypeError(`${label} must use YYYY-MM`);
  }
  return value;
}

function monthFromDate(value: Date, label: string): string {
  if (!Number.isFinite(value.getTime())) throw new TypeError(`${label} must be valid`);
  const year = value.getFullYear();
  if (year < 0 || year > 9999) throw new TypeError(`${label} year must be from 0000 through 9999`);
  return `${String(year).padStart(4, "0")}-${String(value.getMonth() + 1).padStart(2, "0")}`;
}

function enumerateMonths(start: string, end: string): readonly string[] {
  const startIndex = monthIndex(requireMonth(start, "Memoria diary history start month"));
  const endIndex = monthIndex(requireMonth(end, "Memoria diary history end month"));
  if (startIndex > endIndex) {
    throw new SourceReaderError(
      "memoria",
      `Memoria diary history start ${start} is after current month ${end}`,
    );
  }
  const months: string[] = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    const year = Math.floor(index / 12);
    const month = index % 12 + 1;
    months.push(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`);
  }
  return months;
}

function monthIndex(value: string): number {
  const [yearText, monthText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(month)) {
    throw new TypeError("Memoria diary month must contain safe integers");
  }
  return year * 12 + month - 1;
}

function requireResourceId(source: "memoria", value: unknown, label: string): string {
  if (
    (typeof value !== "string" && typeof value !== "number")
    || String(value).trim().length === 0
  ) {
    throw new SourceReaderError(source, `${label} has no valid id`);
  }
  return String(value).trim();
}

function requireRecord(
  source: "memoria",
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new SourceReaderError(source, `${label} must be an object`);
  }
  return value;
}

function isAllowedDetailEndpoint(endpoint: string): boolean {
  return /^\/api\/(?:diary|notes|tasks)\/[^/?#]+$/.test(endpoint);
}

function documentTitle(
  payload: Readonly<Record<string, unknown>>,
  locator: string,
): string {
  for (const key of ["title", "summary", "date"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return locator;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
