import type { SourceName } from "./source-reader.js";

export class SourceReaderError extends Error {
  public readonly source: SourceName;
  public readonly locator: string | null;

  public constructor(
    source: SourceName,
    message: string,
    options?: { readonly locator?: string; readonly cause?: unknown },
  ) {
    super(`[${source}] ${message}`, { cause: options?.cause });
    this.name = "SourceReaderError";
    this.source = source;
    this.locator = options?.locator ?? null;
  }
}
