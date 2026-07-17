import { firstMarkdownHeading, parseFrontmatter } from "./markdown.js";
import { MarkdownDirectoryReader } from "./markdown-directory-reader.js";
import { SourceReaderError } from "./reader-error.js";
import { sourceRefFor, type SourceDocument, type SourceDocumentDescriptor } from "./source-reader.js";

export class MemoryReader extends MarkdownDirectoryReader {
  public readonly source = "memory" as const;

  public constructor(rootDirectory: string) {
    super(rootDirectory);
  }

  protected parseMarkdown(
    descriptor: SourceDocumentDescriptor,
    markdown: string,
  ): SourceDocument {
    const parsed = parseFrontmatter(markdown);
    if (parsed.body.trim().length === 0) {
      throw new SourceReaderError(this.source, "memory body is empty", {
        locator: descriptor.locator,
      });
    }
    const configuredTitle = parsed.attributes.title;
    return {
      descriptor,
      sourceRef: sourceRefFor(descriptor),
      title: typeof configuredTitle === "string" && configuredTitle.trim().length > 0
        ? configuredTitle.trim()
        : firstMarkdownHeading(parsed.body),
      content: parsed.body,
      metadata: {
        frontmatter: parsed.attributes,
      },
    };
  }
}
