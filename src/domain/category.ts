import { z } from "zod";

export const MAX_CATEGORY_NAME_LENGTH = 64;
export const MAX_CATEGORY_DESCRIPTION_LENGTH = 500;

/**
 * Shape-level validation only. The controlled vocabulary itself lives in the
 * `card_categories` table (the runtime source of truth); membership checks are
 * performed against that table, never against a hardcoded list.
 */
export const categoryNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_CATEGORY_NAME_LENGTH);

export const categoryDescriptionSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_CATEGORY_DESCRIPTION_LENGTH);

/** Category assigned when the classifier cannot decide. Seeded by migration 003. */
export const FALLBACK_CATEGORY = "general";

export interface CardCategory {
  name: string;
  description: string;
  createdAt: number;
}

export interface CreateCategoryInput {
  name: string;
  description: string;
}
