import type { Context } from "hono";
import type { ZodType } from "zod";

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

export class ApiInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiInputError";
  }
}

export function inputErrorResponse(c: Context, error: ApiInputError): Response {
  return c.json({ error: error.message }, 400);
}
