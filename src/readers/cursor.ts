import { SourceReaderError } from "./reader-error.js";
import type {
  CursorPosition,
  ReaderCursor,
  SourceDocumentDescriptor,
  SourceName,
} from "./source-reader.js";

export function compareCursorPositions(
  left: CursorPosition,
  right: CursorPosition,
): number {
  if (left.mtimeMs !== right.mtimeMs) {
    return left.mtimeMs < right.mtimeMs ? -1 : 1;
  }
  if (left.locator === right.locator) {
    return 0;
  }
  return left.locator < right.locator ? -1 : 1;
}

export function positionFromDescriptor(
  descriptor: SourceDocumentDescriptor,
): CursorPosition {
  return {
    mtimeMs: descriptor.mtimeMs,
    locator: descriptor.locator,
  };
}

export function cursorFromPosition(position: CursorPosition): ReaderCursor {
  return { ...position };
}

export function serializeReaderCursor(cursor: ReaderCursor): string {
  validatePosition(cursor, "cursor");
  if (cursor.backfill !== undefined) {
    validatePosition(cursor.backfill, "cursor.backfill");
  }
  if (cursor.catchUp !== undefined) {
    validatePosition(cursor.catchUp.target, "cursor.catchUp.target");
    validatePosition(cursor.catchUp.before, "cursor.catchUp.before");
  }
  validateCursorRelations(cursor);
  return JSON.stringify(cursor);
}

export function parseReaderCursor(
  source: SourceName,
  serialized: string | null,
): ReaderCursor | null {
  if (serialized === null) {
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new SourceReaderError(source, "cursor is not valid JSON", { cause: error });
  }
  if (!isRecord(value)) {
    throw new SourceReaderError(source, "cursor must be a JSON object");
  }

  const cursor = parsePosition(source, value, "cursor") as ReaderCursor;
  const backfill = value.backfill;
  const catchUp = value.catchUp;

  if (backfill !== undefined) {
    if (!isRecord(backfill)) {
      throw new SourceReaderError(source, "cursor.backfill must be an object");
    }
    Object.assign(cursor, { backfill: parsePosition(source, backfill, "cursor.backfill") });
  }

  if (catchUp !== undefined) {
    if (!isRecord(catchUp) || !isRecord(catchUp.target) || !isRecord(catchUp.before)) {
      throw new SourceReaderError(
        source,
        "cursor.catchUp must contain target and before positions",
      );
    }
    Object.assign(cursor, {
      catchUp: {
        target: parsePosition(source, catchUp.target, "cursor.catchUp.target"),
        before: parsePosition(source, catchUp.before, "cursor.catchUp.before"),
      },
    });
  }

  assertCursorForSource(source, cursor);
  return cursor;
}

export function assertCursorForSource(
  source: SourceName,
  cursor: ReaderCursor | null,
): void {
  if (cursor === null) {
    return;
  }
  try {
    validatePosition(cursor, "cursor");
    if (cursor.backfill !== undefined) {
      validatePosition(cursor.backfill, "cursor.backfill");
    }
    if (cursor.catchUp !== undefined) {
      validatePosition(cursor.catchUp.target, "cursor.catchUp.target");
      validatePosition(cursor.catchUp.before, "cursor.catchUp.before");
    }
    validateCursorRelations(cursor);
  } catch (error) {
    if (error instanceof SourceReaderError) {
      throw error;
    }
    throw new SourceReaderError(source, "cursor is invalid", { cause: error });
  }
}

function validateCursorRelations(cursor: ReaderCursor): void {
  if (
    cursor.backfill !== undefined
    && compareCursorPositions(cursor.backfill, cursor) > 0
  ) {
    throw new TypeError("cursor.backfill cannot be newer than the high-water mark");
  }
  if (cursor.catchUp === undefined) {
    return;
  }
  if (compareCursorPositions(cursor.catchUp.target, cursor) <= 0) {
    throw new TypeError("cursor.catchUp.target must be newer than the high-water mark");
  }
  if (
    compareCursorPositions(cursor.catchUp.before, cursor) <= 0
    || compareCursorPositions(cursor.catchUp.before, cursor.catchUp.target) > 0
  ) {
    throw new TypeError("cursor.catchUp.before must be within the pending catch-up range");
  }
}

function parsePosition(
  source: SourceName,
  record: Readonly<Record<string, unknown>>,
  label: string,
): CursorPosition {
  const position = {
    mtimeMs: record.mtimeMs,
    locator: record.locator,
  };
  try {
    validatePosition(position, label);
  } catch (error) {
    throw new SourceReaderError(source, `${label} has an invalid position`, { cause: error });
  }
  return position;
}

function validatePosition(value: unknown, label: string): asserts value is CursorPosition {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  if (
    typeof value.mtimeMs !== "number"
    || !Number.isFinite(value.mtimeMs)
    || value.mtimeMs < 0
  ) {
    throw new TypeError(`${label}.mtimeMs must be a non-negative finite number`);
  }
  if (typeof value.locator !== "string" || value.locator.length === 0) {
    throw new TypeError(`${label}.locator must be a non-empty string`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
