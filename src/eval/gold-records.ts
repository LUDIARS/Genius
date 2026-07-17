import { readFile } from "node:fs/promises";
import { z } from "zod";

/** Canonical JSONL line: {"query":"...","expectedSourceRefs":["reader:source#anchor"]}. */
const goldRecordSchema = z
  .object({
    query: z.string().trim().min(1),
    expectedSourceRefs: z
      .array(z.string().trim().min(1))
      .min(1)
      .refine((refs) => new Set(refs).size === refs.length, "expectedSourceRefs must be unique"),
  })
  .strict();

export type GoldRecord = z.infer<typeof goldRecordSchema>;

export type GoldFileResult =
  | { kind: "missing" }
  | { kind: "loaded"; records: GoldRecord[] };

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export async function loadGoldRecords(path: string): Promise<GoldFileResult> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return { kind: "missing" };
    throw new Error(`Failed to read gold evaluation file ${path}`, { cause: error });
  }

  const records: GoldRecord[] = [];
  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;

    let decoded: unknown;
    try {
      decoded = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`Malformed gold JSONL at line ${index + 1}: invalid JSON`, { cause: error });
    }

    const parsed = goldRecordSchema.safeParse(decoded);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "record"}: ${issue.message}`)
        .join("; ");
      throw new Error(`Malformed gold JSONL at line ${index + 1}: ${detail}`);
    }
    records.push(parsed.data);
  }

  if (records.length === 0) {
    throw new Error("Malformed gold JSONL: the file contains no records");
  }
  return { kind: "loaded", records };
}
