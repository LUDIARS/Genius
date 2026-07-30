import type { CloneCard } from "../domain/card.js";

export interface SupersedeChain {
  card: CloneCard;
  /** Cards this card replaced, transitively, oldest first. */
  supersedes: CloneCard[];
  /** Cards that replaced this card, following `superseded_by` forward. */
  supersededBy: CloneCard[];
}

/** The card lookups the chain resolver needs; a narrow port over the repository. */
export interface SupersedeChainSource {
  getById(id: string): CloneCard | null;
  /** Cards whose `superseded_by` points at the given card. */
  listSupersededByCardId(id: string): CloneCard[];
}

/**
 * Resolves the retirement history around one card so the UI can show what a
 * card replaced and what replaced it (spec/feature/operations.md Section 5).
 *
 * `superseded_by` forms a chain forward (one replacement per card) but several
 * cards may be retired in favour of the same replacement, so the backward walk
 * is a breadth-first traversal. Both walks carry a visited set: the repository
 * rejects cycles on write, yet a chain read must not be able to hang the
 * service if a legacy row is inconsistent.
 */
export function resolveSupersedeChain(
  source: SupersedeChainSource,
  id: string,
): SupersedeChain | null {
  const card = source.getById(id);
  if (card === null) return null;
  return {
    card,
    supersedes: collectSuperseded(source, card),
    supersededBy: collectReplacements(source, card),
  };
}

function collectReplacements(source: SupersedeChainSource, card: CloneCard): CloneCard[] {
  const replacements: CloneCard[] = [];
  const visited = new Set<string>([card.id]);
  let nextId = card.supersededBy;
  while (nextId !== null && !visited.has(nextId)) {
    visited.add(nextId);
    const replacement = source.getById(nextId);
    if (replacement === null) {
      throw new Error(`Superseding card not found: ${nextId}`);
    }
    replacements.push(replacement);
    nextId = replacement.supersededBy;
  }
  return replacements;
}

function collectSuperseded(source: SupersedeChainSource, card: CloneCard): CloneCard[] {
  const superseded: CloneCard[] = [];
  const visited = new Set<string>([card.id]);
  const queue: string[] = [card.id];
  while (queue.length > 0) {
    const currentId = queue.shift();
    if (currentId === undefined) break;
    for (const predecessor of source.listSupersededByCardId(currentId)) {
      if (visited.has(predecessor.id)) continue;
      visited.add(predecessor.id);
      superseded.push(predecessor);
      queue.push(predecessor.id);
    }
  }
  return superseded.sort((left, right) => left.createdAt - right.createdAt);
}
