import { parseMarkdownSections } from "./markdown.js";
import { MarkdownDirectoryReader } from "./markdown-directory-reader.js";
import { sourceRefFor, type SourceDocument, type SourceDocumentDescriptor } from "./source-reader.js";

export class SessionLogReader extends MarkdownDirectoryReader {
  public readonly source = "session-logs" as const;

  public constructor(rootDirectory: string) {
    super(rootDirectory);
  }

  protected parseMarkdown(
    descriptor: SourceDocumentDescriptor,
    markdown: string,
  ): SourceDocument {
    const sections = parseMarkdownSections(markdown);
    return {
      descriptor,
      sourceRef: sourceRefFor(descriptor),
      title: sections.find((section) => section.heading !== null)?.heading ?? null,
      content: markdown,
      metadata: { sections },
    };
  }
}
