import type { Context } from "hono";
import type { ZodType } from "zod";
import type { ApiServices } from "./contracts.js";

export function parseOrThrow<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiInputError(result.error.issues.map((issue) => issue.message).join("; "));
  }
  return result.data;
}

export async function readJsonOrThrow(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiInputError("Request body must contain valid JSON");
  }
}

/**
 * Rejects category values outside the controlled vocabulary with a 400 —
 * unknown categories are never silently ignored (spec/feature/operations.md
 * Section 1.3).
 */
export async function assertKnownCategories(
  categories: Pick<ApiServices["categories"], "findUnknown">,
  names: readonly string[],
): Promise<void> {
  if (names.length === 0) return;
  // query-batch can carry the same category across up to 50 queries; dedupe so a
  // batch costs one lookup per distinct name and the 400 lists each name once.
  const unknown = await categories.findUnknown([...new Set(names)]);
  if (unknown.length > 0) {
    throw new ApiInputError(`Unknown categories: ${unknown.join(", ")}`);
  }
}

export class ApiInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiInputError";
  }
}

export function inputErrorResponse(c: Context, error: ApiInputError): Response {
  return c.json({ error: error.message }, 400);
}
