import type { Hono } from "hono";
import { z } from "zod";
import { CategoryExistsError } from "../../categories/category-repository.js";
import { categoryDescriptionSchema, categoryNameSchema } from "../../domain/category.js";
import type { ApiServices } from "../contracts.js";
import { parseOrThrow, readJsonOrThrow } from "../validation.js";

const createCategorySchema = z
  .object({
    name: categoryNameSchema,
    description: categoryDescriptionSchema,
  })
  .strict();

export function registerCategoryRoutes(
  app: Hono,
  categories: ApiServices["categories"],
): void {
  app.get("/api/clone/categories", async (c) =>
    c.json({ categories: await categories.list() }));

  // Categories can be added but never deleted (cards keep referencing them).
  app.post("/api/clone/categories", async (c) => {
    const input = parseOrThrow(createCategorySchema, await readJsonOrThrow(c));
    try {
      return c.json(await categories.create(input), 201);
    } catch (error) {
      if (error instanceof CategoryExistsError) {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
  });
}
