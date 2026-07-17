import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { createTierTwoBatch } from "./batch.js";
import { listFilesRecursively, resolveSourceFile } from "./file-tree.js";
import {
  createReplayableJsonlTranscript,
  type TranscriptRecordFormatter,
} from "./jsonl-transcript.js";
import { SourceReaderError } from "./reader-error.js";
import {
  sourceRefFor,
  type ListDocumentsOptions,
  type ReaderCursor,
  type SourceDocument,
  type SourceDocumentBatch,
  type SourceDocumentDescriptor,
  type SourceName,
  type SourceReader,
} from "./source-reader.js";

export class TierTwoJsonlReader implements SourceReader {
  public readonly tier = 2 as const;
  private readonly rootDirectory: string;

  public constructor(
    public readonly source: Extract<SourceName, "claude-jsonl" | "codex-jsonl">,
    rootDirectory: string,
    private readonly formatter: TranscriptRecordFormatter,
  ) {
    if (rootDirectory.trim().length === 0) {
      throw new TypeError("rootDirectory must be a non-empty path");
    }
    this.rootDirectory = resolve(rootDirectory);
  }

  public async listDocuments(
    cursor: ReaderCursor | null,
    options?: ListDocumentsOptions,
  ): Promise<SourceDocumentBatch> {
    const files = await listFilesRecursively(
      this.source,
      this.rootDirectory,
      (locator) => locator.toLowerCase().endsWith(".jsonl"),
    );
    const descriptors = files.map((file): SourceDocumentDescriptor => ({
      source: this.source,
      tier: this.tier,
      locator: file.locator,
      mtimeMs: file.mtimeMs,
      sizeBytes: file.sizeBytes,
    }));
    return createTierTwoBatch(this.source, descriptors, cursor, options?.budgetFiles);
  }

  public async readDocument(
    descriptor: SourceDocumentDescriptor,
  ): Promise<SourceDocument> {
    this.assertDescriptor(descriptor);
    const absolutePath = resolveSourceFile(
      this.source,
      this.rootDirectory,
      descriptor.locator,
    );
    let fileStat;
    try {
      fileStat = await stat(absolutePath);
    } catch (error) {
      throw new SourceReaderError(this.source, "JSONL source document is unavailable", {
        locator: descriptor.locator,
        cause: error,
      });
    }
    if (!fileStat.isFile()) {
      throw new SourceReaderError(this.source, "JSONL source document is not a file", {
        locator: descriptor.locator,
      });
    }

    return {
      descriptor,
      sourceRef: sourceRefFor(descriptor),
      title: basename(descriptor.locator, ".jsonl"),
      content: createReplayableJsonlTranscript(
        this.source,
        descriptor.locator,
        absolutePath,
        this.formatter,
      ),
      metadata: { format: "jsonl-transcript" },
    };
  }

  private assertDescriptor(descriptor: SourceDocumentDescriptor): void {
    if (descriptor.source !== this.source || descriptor.tier !== this.tier) {
      throw new SourceReaderError(this.source, "descriptor belongs to another reader", {
        locator: descriptor.locator,
      });
    }
  }
}
