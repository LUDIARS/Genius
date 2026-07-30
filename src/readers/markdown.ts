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

const NESTED_KEY_VALUE = /^\s+([A-Za-z0-9_.-]+):(?:\s*(.*))?$/;
const LIST_ITEM = /^\s+-\s+/;

function parseSimpleYamlObject(header: string): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  const lines = header.split("\n");
  let activeArrayKey: string | null = null;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) {
      index += 1;
      continue;
    }

    const arrayItem = /^\s+-\s+(.+)$/.exec(line);
    if (arrayItem !== null && activeArrayKey !== null) {
      const existing = result[activeArrayKey];
      if (!Array.isArray(existing)) {
        throw new Error(`frontmatter line ${index + 1} has an invalid list`);
      }
      existing.push(parseYamlScalar(arrayItem[1] ?? ""));
      index += 1;
      continue;
    }

    const keyValue = /^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/.exec(line);
    if (keyValue === null) {
      throw new Error(`frontmatter line ${index + 1} is not a supported key/value`);
    }
    const key = keyValue[1] ?? "";
    const rawValue = keyValue[2] ?? "";
    assertAssignableKey(key, index);
    if (Object.hasOwn(result, key)) {
      throw new Error(`frontmatter key is duplicated: ${key}`);
    }
    activeArrayKey = null;
    if (rawValue.length > 0) {
      result[key] = parseYamlScalar(rawValue);
      index += 1;
      continue;
    }

    // Empty value: either a YAML list (`- item` lines) or a one-level nested
    // object (`  key: value` lines, e.g. memory frontmatter's `metadata:`
    // block). Peek at the next line to tell them apart.
    const nextLine = lines[index + 1] ?? "";
    if (NESTED_KEY_VALUE.test(nextLine) && !LIST_ITEM.test(nextLine)) {
      const consumed = parseNestedObject(lines, index + 1);
      result[key] = consumed.object;
      index = consumed.nextIndex;
      continue;
    }
    result[key] = [];
    activeArrayKey = key;
    index += 1;
  }
  return result;
}

/**
 * Parses a one-level-deep nested object (flat `key: value` lines indented
 * under a parent key). Stops at the first line whose indentation is less
 * than the first nested line's indentation. Nested values must be scalars;
 * arrays/further nesting inside a nested object are rejected explicitly
 * rather than silently flattened or coerced to an empty scalar.
 */
function parseNestedObject(
  lines: readonly string[],
  startIndex: number,
): { object: Record<string, unknown>; nextIndex: number } {
  const object: Record<string, unknown> = {};
  const baseIndent = lines[startIndex]?.match(/^\s*/)?.[0]?.length ?? 0;
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    const indent = line.match(/^\s*/)?.[0]?.length ?? 0;
    if (indent < baseIndent) {
      break;
    }
    if (indent > baseIndent) {
      throw new Error(`frontmatter line ${index + 1} nests deeper than one level`);
    }
    const match = NESTED_KEY_VALUE.exec(line);
    if (match === null) {
      throw new Error(`frontmatter line ${index + 1} is not a supported nested key/value`);
    }
    const key = match[1] ?? "";
    const rawValue = match[2] ?? "";
    if (rawValue.trim().length === 0) {
      throw new Error(`frontmatter nested key has no scalar value: ${key}`);
    }
    assertAssignableKey(key, index);
    if (Object.hasOwn(object, key)) {
      throw new Error(`frontmatter nested key is duplicated: ${key}`);
    }
    object[key] = parseYamlScalar(rawValue);
    index += 1;
  }
  return { object, nextIndex: index };
}

/**
 * `__proto__` assigned through a computed property mutates the target's
 * prototype instead of adding an own key, so `Object.hasOwn` would never see
 * it. Reject it instead of letting a source file reshape a parsed object.
 */
function assertAssignableKey(key: string, index: number): void {
  if (key === "__proto__") {
    throw new Error(`frontmatter line ${index + 1} uses a reserved key: ${key}`);
  }
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
