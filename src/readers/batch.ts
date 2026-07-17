import {
  assertCursorForSource,
  compareCursorPositions,
  positionFromDescriptor,
} from "./cursor.js";
import { SourceReaderError } from "./reader-error.js";
import type {
  CursorPosition,
  ReaderCursor,
  SourceDocumentBatch,
  SourceDocumentDescriptor,
  SourceName,
} from "./source-reader.js";

export function createTierOneBatch(
  source: SourceName,
  descriptors: readonly SourceDocumentDescriptor[],
  cursor: ReaderCursor | null,
): SourceDocumentBatch {
  assertCursorForSource(source, cursor);
  const ordered = [...descriptors]
    .filter((descriptor) =>
      cursor === null || compareCursorPositions(positionFromDescriptor(descriptor), cursor) > 0)
    .sort(compareDescriptorsAscending);
  const last = ordered.at(-1);
  return {
    documents: ordered,
    nextCursor: last === undefined
      ? cursor
      : positionFromDescriptor(last),
  };
}

export function createTierTwoBatch(
  source: SourceName,
  descriptors: readonly SourceDocumentDescriptor[],
  cursor: ReaderCursor | null,
  budgetFiles: number | undefined,
): SourceDocumentBatch {
  assertCursorForSource(source, cursor);
  const budget = requireBudget(source, budgetFiles);
  const ordered = [...descriptors].sort(compareDescriptorsDescending);
  if (ordered.length === 0) {
    return { documents: [], nextCursor: cursor };
  }
  if (cursor === null) {
    const documents = ordered.slice(0, budget);
    const head = documents[0];
    const tail = documents.at(-1);
    if (head === undefined || tail === undefined) {
      return { documents: [], nextCursor: null };
    }
    return {
      documents,
      nextCursor: {
        ...positionFromDescriptor(head),
        backfill: positionFromDescriptor(tail),
      },
    };
  }

  const selected: SourceDocumentDescriptor[] = [];
  let remainingBudget = budget;
  let highWatermark: CursorPosition = cursor;
  let backfill: CursorPosition = cursor.backfill ?? cursor;
  let catchUp = cursor.catchUp;

  if (catchUp !== undefined) {
    const activeCatchUp = catchUp;
    const pending = ordered.filter((descriptor) => {
      const position = positionFromDescriptor(descriptor);
      return compareCursorPositions(position, highWatermark) > 0
        && compareCursorPositions(position, activeCatchUp.target) <= 0
        && compareCursorPositions(position, activeCatchUp.before) < 0;
    });
    const taken = pending.slice(0, remainingBudget);
    selected.push(...taken);
    remainingBudget -= taken.length;

    if (pending.length > taken.length) {
      const tail = taken.at(-1);
      if (tail === undefined) {
        throw new SourceReaderError(source, "Tier 2 catch-up made no progress");
      }
      return {
        documents: selected,
        nextCursor: {
          ...highWatermark,
          backfill,
          catchUp: {
            target: activeCatchUp.target,
            before: positionFromDescriptor(tail),
          },
        },
      };
    }

    highWatermark = activeCatchUp.target;
    catchUp = undefined;
    // A newer wave may have arrived above target while this range was being
    // drained. Start it on the next call so every returned batch remains in
    // strict mtime-descending order rather than appending new head files after
    // older catch-up entries.
    return {
      documents: selected,
      nextCursor: {
        ...highWatermark,
        backfill,
      },
    };
  }

  if (remainingBudget > 0) {
    const newer = ordered.filter(
      (descriptor) =>
        compareCursorPositions(positionFromDescriptor(descriptor), highWatermark) > 0,
    );
    if (newer.length > 0) {
      const targetDescriptor = newer[0];
      if (targetDescriptor === undefined) {
        throw new SourceReaderError(source, "Tier 2 recent scan has no head document");
      }
      const taken = newer.slice(0, remainingBudget);
      selected.push(...taken);
      remainingBudget -= taken.length;

      if (newer.length > taken.length) {
        const tail = taken.at(-1);
        if (tail === undefined) {
          throw new SourceReaderError(source, "Tier 2 recent scan made no progress");
        }
        return {
          documents: selected,
          nextCursor: {
            ...highWatermark,
            backfill,
            catchUp: {
              target: positionFromDescriptor(targetDescriptor),
              before: positionFromDescriptor(tail),
            },
          },
        };
      }
      highWatermark = positionFromDescriptor(targetDescriptor);
    }
  }

  if (remainingBudget > 0) {
    const older = ordered.filter(
      (descriptor) => compareCursorPositions(positionFromDescriptor(descriptor), backfill) < 0,
    );
    const taken = older.slice(0, remainingBudget);
    selected.push(...taken);
    const tail = taken.at(-1);
    if (tail !== undefined) {
      backfill = positionFromDescriptor(tail);
    }
  }

  return {
    documents: selected,
    nextCursor: {
      ...highWatermark,
      backfill,
      ...(catchUp === undefined ? {} : { catchUp }),
    },
  };
}

function requireBudget(source: SourceName, value: number | undefined): number {
  if (value === undefined) {
    throw new SourceReaderError(source, "Tier 2 requires budgetFiles");
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new SourceReaderError(source, "budgetFiles must be a positive integer");
  }
  return value;
}

function compareDescriptorsAscending(
  left: SourceDocumentDescriptor,
  right: SourceDocumentDescriptor,
): number {
  return compareCursorPositions(positionFromDescriptor(left), positionFromDescriptor(right));
}

function compareDescriptorsDescending(
  left: SourceDocumentDescriptor,
  right: SourceDocumentDescriptor,
): number {
  return compareDescriptorsAscending(right, left);
}
