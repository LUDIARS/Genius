export interface MarkdownSection {
  readonly heading: string | null;
  readonly level: number;
  readonly content: string;
}

export interface ParsedFrontmatter {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly body: string;
}

export function parseFrontmatter(markdown: string): ParsedFrontmatter {
  const normalized = stripByteOrderMark(markdown).replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) {
    return { attributes: {}, body: normalized };
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) {
    throw new Error("frontmatter opening delimiter has no closing delimiter");
  }
  const header = normalized.slice(4, end);
  const body = normalized.slice(end + 5);
  return {
    attributes: parseSimpleYamlObject(header),
    body,
  };
}

export function parseMarkdownSections(markdown: string): readonly MarkdownSection[] {
  const lines = stripByteOrderMark(markdown).replaceAll("\r\n", "\n").split("\n");
  const sections: MarkdownSection[] = [];
  let heading: string | null = null;
  let level = 0;
  let contentLines: string[] = [];
  let fence: "```" | "~~~" | null = null;

  const flush = (): void => {
    const content = contentLines.join("\n").trim();
    if (heading !== null || content.length > 0) {
      sections.push({ heading, level, content });
    }
    contentLines = [];
  };

  for (const line of lines) {
    const trimmedStart = line.trimStart();
    if (fence !== null) {
      contentLines.push(line);
      if (trimmedStart.startsWith(fence)) {
        fence = null;
      }
      continue;
    }
    if (trimmedStart.startsWith("```")) {
      fence = "```";
      contentLines.push(line);
      continue;
    }
    if (trimmedStart.startsWith("~~~")) {
      fence = "~~~";
      contentLines.push(line);
      continue;
    }

    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match !== null) {
      flush();
      level = match[1]?.length ?? 0;
      heading = match[2]?.trim() ?? null;
      continue;
    }
    contentLines.push(line);
  }
  flush();
  return sections;
}

export function firstMarkdownHeading(markdown: string): string | null {
  return parseMarkdownSections(markdown).find((section) => section.heading !== null)?.heading ?? null;
}

function parseSimpleYamlObject(header: string): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  const lines = header.split("\n");
  let activeArrayKey: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) {
      continue;
    }

    const arrayItem = /^\s+-\s+(.+)$/.exec(line);
    if (arrayItem !== null && activeArrayKey !== null) {
      const existing = result[activeArrayKey];
      if (!Array.isArray(existing)) {
        throw new Error(`frontmatter line ${index + 1} has an invalid list`);
      }
      existing.push(parseYamlScalar(arrayItem[1] ?? ""));
      continue;
    }

    const keyValue = /^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/.exec(line);
    if (keyValue === null) {
      throw new Error(`frontmatter line ${index + 1} is not a supported key/value`);
    }
    const key = keyValue[1] ?? "";
    const rawValue = keyValue[2] ?? "";
    if (Object.hasOwn(result, key)) {
      throw new Error(`frontmatter key is duplicated: ${key}`);
    }
    if (rawValue.length === 0) {
      result[key] = [];
      activeArrayKey = key;
      continue;
    }
    result[key] = parseYamlScalar(rawValue);
    activeArrayKey = null;
  }
  return result;
}

function parseYamlScalar(rawValue: string): unknown {
  const value = rawValue.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    return inner.length === 0
      ? []
      : inner.split(",").map((item) => parseYamlScalar(item));
  }
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (value === "null" || value === "~") {
    return null;
  }
  const number = Number(value);
  if (value.length > 0 && Number.isFinite(number)) {
    return number;
  }
  return value;
}

function stripByteOrderMark(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
