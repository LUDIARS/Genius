import { z } from "zod";
import type { CardCategory } from "../domain/category.js";

/**
 * Placeholder in prompts/distill.md replaced at startup with the vocabulary
 * generated from the card_categories table. The prompt file itself must never
 * contain a hardcoded category list — that would create a second source of
 * truth that silently drifts when categories are added
 * (spec/feature/operations.md Section 1.1).
 */
export const CATEGORY_VOCABULARY_PLACEHOLDER = "{{category-vocabulary}}";

export function renderCategoryVocabulary(categories: readonly CardCategory[]): string {
  if (categories.length === 0) {
    throw new Error("Category vocabulary must not be empty");
  }
  return categories
    .map((category) => `- \`${category.name}\` — ${category.description}`)
    .join("\n");
}

export function renderDistillPrompt(
  template: string,
  categories: readonly CardCategory[],
): string {
  if (!template.includes(CATEGORY_VOCABULARY_PLACEHOLDER)) {
    throw new Error(
      `Distillation prompt template is missing the ${CATEGORY_VOCABULARY_PLACEHOLDER} placeholder`,
    );
  }
  // A function replacer is required: category descriptions are operator-supplied
  // (POST /api/clone/categories), and a string replacement would interpret `$&`
  // or `$$` in a description as a replacement pattern and corrupt the prompt.
  const vocabulary = renderCategoryVocabulary(categories);
  return template.replaceAll(CATEGORY_VOCABULARY_PLACEHOLDER, () => vocabulary);
}

/**
 * Strict enum over the controlled vocabulary. LLM output with a category
 * outside this set fails validation (and is retried/rejected) — it is never
 * silently coerced to `general`.
 */
export function categoryEnumSchema(names: readonly string[]): z.ZodType<string> {
  if (names.length === 0) throw new Error("Category vocabulary must not be empty");
  if (names.some((name) => name.trim() === "")) {
    throw new Error("Category vocabulary must not contain empty names");
  }
  return z.enum([...names] as [string, ...string[]]);
}
