import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { createTierOneBatch } from "./batch.js";
import {
  listFilesRecursively,
  normalizeLocator,
  resolveSourceFile,
} from "./file-tree.js";
import { firstMarkdownHeading } from "./markdown.js";
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

export class ReviewReader implements SourceReader {
  public readonly source = "review" as const;
  public readonly tier = 1 as const;
  private readonly rootDirectory: string;

  public constructor(rootDirectory: string) {
    if (rootDirectory.trim().length === 0) {
      throw new TypeError("rootDirectory must be a non-empty path");
    }
    this.rootDirectory = resolve(rootDirectory);
  }

  public async listDocuments(
    cursor: ReaderCursor | null,
    _options?: ListDocumentsOptions,
  ): Promise<SourceDocumentBatch> {
    const manifests = await listFilesRecursively(
      this.source,
      this.rootDirectory,
      isProjectLatestManifest,
    );
    const descriptors: SourceDocumentDescriptor[] = [];

    for (const manifest of manifests) {
      const manifestValue = await this.readManifest(manifest.locator);
      const projectDirectory = dirname(manifest.absolutePath);
      const latestDirectory = resolve(projectDirectory, manifestValue.date);
      const markdownFiles = await listFilesRecursively(
        this.source,
        latestDirectory,
        (locator) => locator.toLowerCase().endsWith(".md"),
      );
      if (markdownFiles.length === 0) {
        throw new SourceReaderError(
          this.source,
          `latest review has no Markdown documents: ${manifestValue.date}`,
          { locator: manifest.locator },
        );
      }
      for (const markdownFile of markdownFiles) {
        descriptors.push({
          source: this.source,
          tier: this.tier,
          locator: normalizeLocator(relative(this.rootDirectory, markdownFile.absolutePath)),
          mtimeMs: Math.max(manifest.mtimeMs, markdownFile.mtimeMs),
          sizeBytes: markdownFile.sizeBytes,
          nativeId: manifest.locator,
        });
      }
    }

    return createTierOneBatch(this.source, descriptors, cursor);
  }

  public async readDocument(
    descriptor: SourceDocumentDescriptor,
  ): Promise<SourceDocument> {
    this.assertDescriptor(descriptor);
    if (descriptor.nativeId === undefined) {
      throw new SourceReaderError(this.source, "review descriptor has no manifest locator", {
        locator: descriptor.locator,
      });
    }

    const markdownPath = resolveSourceFile(
      this.source,
      this.rootDirectory,
      descriptor.locator,
    );
    const manifest = await this.readManifest(descriptor.nativeId);
    let markdown: string;
    try {
      markdown = await readFile(markdownPath, "utf8");
    } catch (error) {
      throw new SourceReaderError(this.source, "cannot read review Markdown", {
        locator: descriptor.locator,
        cause: error,
      });
    }
    if (markdown.trim().length === 0) {
      throw new SourceReaderError(this.source, "review Markdown is empty", {
        locator: descriptor.locator,
      });
    }

    const manifestJson = JSON.stringify(manifest.raw, null, 2);
    const title = firstMarkdownHeading(markdown)
      ?? (typeof manifest.raw.repo === "string" ? manifest.raw.repo : null);
    return {
      descriptor,
      sourceRef: sourceRefFor(descriptor),
      title,
      content: `# Review metadata\n\n\`\`\`json\n${manifestJson}\n\`\`\`\n\n# Review document\n\n${markdown}`,
      metadata: { manifest: manifest.raw },
    };
  }

  private async readManifest(locator: string): Promise<ReviewManifest> {
    const manifestPath = resolveSourceFile(this.source, this.rootDirectory, locator);
    let text: string;
    try {
      text = await readFile(manifestPath, "utf8");
    } catch (error) {
      throw new SourceReaderError(this.source, "cannot read latest.json", {
        locator,
        cause: error,
      });
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new SourceReaderError(this.source, "latest.json is malformed", {
        locator,
        cause: error,
      });
    }
    if (!isRecord(raw) || typeof raw.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) {
      throw new SourceReaderError(
        this.source,
        "latest.json must contain date in YYYY-MM-DD format",
        { locator },
      );
    }
    return { date: raw.date, raw };
  }

  private assertDescriptor(descriptor: SourceDocumentDescriptor): void {
    if (descriptor.source !== this.source || descriptor.tier !== this.tier) {
      throw new SourceReaderError(this.source, "descriptor belongs to another reader", {
        locator: descriptor.locator,
      });
    }
  }
}

interface ReviewManifest {
  readonly date: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

function isProjectLatestManifest(locator: string): boolean {
  const parts = locator.split("/");
  return parts.at(-1)?.toLowerCase() === "latest.json" && parts.length <= 2;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
