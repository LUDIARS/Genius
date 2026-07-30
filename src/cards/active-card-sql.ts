/**
 * The single definition of "active card" in SQL.
 *
 * A card leaves the active set in two independent ways: a replacement points
 * away from it (`superseded_by`), or it was retired outright with no
 * replacement (`retired_at`, spec/feature/operations.md Section 5). Both
 * conditions are spelled out here and nowhere else — the list, the count, the
 * vector search, the query port, the distillation duplicate check and the
 * public export all read them from this module.
 *
 * The conditions must not be copied into those call sites: a copy that misses
 * one of them silently puts retired cards back into search results or into the
 * public export, and it is invisible in a diff of the file that added a new
 * condition here.
 */

function isNullCondition(column: string, alias?: string): string {
  const qualifier = alias === undefined ? "" : `${alias}.`;
  return `${qualifier}${column} IS NULL`;
}

/** `[<alias>.]superseded_by IS NULL` — no replacement card supersedes it. */
export function notSupersededCondition(alias?: string): string {
  return isNullCondition("superseded_by", alias);
}

/** `[<alias>.]retired_at IS NULL` — not retired without a replacement. */
export function notRetiredCondition(alias?: string): string {
  return isNullCondition("retired_at", alias);
}

/**
 * Every active condition as separate fragments, for callers that maintain a
 * list of clauses they later join with AND.
 */
export function activeCardConditions(alias?: string): string[] {
  return [notSupersededCondition(alias), notRetiredCondition(alias)];
}

/**
 * The active predicate as one AND-joined fragment. Safe to drop into an
 * existing AND chain; parenthesise it if a caller ever ORs it with something.
 */
export function activeCardClause(alias?: string): string {
  return activeCardConditions(alias).join(" AND ");
}
