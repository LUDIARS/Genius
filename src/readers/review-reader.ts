import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { createTierOneBatch } from "./batch.js";
import {
  listFilesRecursively,
  normalizeLocator,
  resolveSourceFile,
  type FileEntry,
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
      const markdownFiles = await this.listLatestMarkdown(latestDirectory);
      if (markdownFiles.length === 0) {
        // 日次差分レビュー (format_version 2) は review.json だけを書き、
        // Markdown ドキュメントを残さない。これはエラーではなく「新しい
        // フル形式レビューが無い」状態なので、このプロジェクトを読み飛ばす
        // (throw すると review ソース全体が毎 run 失敗する — Memoria #696)。
        continue;
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

  /**
   * latest.json が指す日付ディレクトリの Markdown を列挙する。ディレクトリ自体が
   * 無い (古いレビューが整理された / まだ書き出されていない) のは「読むものが
   * 無い」であってエラーではないので空として扱う — throw すると 1 プロジェクトの
   * 状態で review ソース全体が毎 run 失敗する (Memoria #696 と同じ失敗形)。
   */
  private async listLatestMarkdown(directory: string): Promise<readonly FileEntry[]> {
    try {
      return await listFilesRecursively(
        this.source,
        directory,
        (locator) => locator.toLowerCase().endsWith(".md"),
      );
    } catch (error) {
      if (error instanceof SourceReaderError && isMissingEntry(error.cause)) return [];
      throw error;
    }
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

/** 「そこに無い」だけの失敗か (壊れた設定や権限エラーとは区別する)。 */
function isMissingEntry(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException | null | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
