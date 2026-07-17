import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createTierOneBatch } from "./batch.js";
import { listFilesRecursively, resolveSourceFile } from "./file-tree.js";
import { SourceReaderError } from "./reader-error.js";
import type {
  ListDocumentsOptions,
  ReaderCursor,
  SourceDocument,
  SourceDocumentBatch,
  SourceDocumentDescriptor,
  SourceName,
  SourceReader,
} from "./source-reader.js";

export abstract class MarkdownDirectoryReader implements SourceReader {
  public abstract readonly source: SourceName;
  public readonly tier = 1 as const;
  protected readonly rootDirectory: string;

  protected constructor(rootDirectory: string) {
    if (rootDirectory.trim().length === 0) {
      throw new TypeError("rootDirectory must be a non-empty path");
    }
    this.rootDirectory = resolve(rootDirectory);
  }

  public async listDocuments(
    cursor: ReaderCursor | null,
    _options?: ListDocumentsOptions,
  ): Promise<SourceDocumentBatch> {
    const files = await listFilesRecursively(
      this.source,
      this.rootDirectory,
      (locator) => locator.toLowerCase().endsWith(".md"),
    );
    const descriptors = files.map((file): SourceDocumentDescriptor => ({
      source: this.source,
      tier: this.tier,
      locator: file.locator,
      mtimeMs: file.mtimeMs,
      sizeBytes: file.sizeBytes,
    }));
    return createTierOneBatch(this.source, descriptors, cursor);
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
    let markdown: string;
    try {
      markdown = await readFile(absolutePath, "utf8");
    } catch (error) {
      throw new SourceReaderError(this.source, "cannot read source document", {
        locator: descriptor.locator,
        cause: error,
      });
    }
    if (markdown.trim().length === 0) {
      throw new SourceReaderError(this.source, "source document is empty", {
        locator: descriptor.locator,
      });
    }
    try {
      return this.parseMarkdown(descriptor, markdown);
    } catch (error) {
      if (error instanceof SourceReaderError) {
        throw error;
      }
      throw new SourceReaderError(this.source, "source document is malformed", {
        locator: descriptor.locator,
        cause: error,
      });
    }
  }

  protected abstract parseMarkdown(
    descriptor: SourceDocumentDescriptor,
    markdown: string,
  ): SourceDocument;

  protected assertDescriptor(descriptor: SourceDocumentDescriptor): void {
    if (descriptor.source !== this.source || descriptor.tier !== this.tier) {
      throw new SourceReaderError(this.source, "descriptor belongs to another reader", {
        locator: descriptor.locator,
      });
    }
  }
}
