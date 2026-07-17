import { parseMarkdownSections } from "./markdown.js";
import { MarkdownDirectoryReader } from "./markdown-directory-reader.js";
import { sourceRefFor, type SourceDocument, type SourceDocumentDescriptor } from "./source-reader.js";

export class ChannelArchiveReader extends MarkdownDirectoryReader {
  public readonly source = "channel-archives" as const;

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
