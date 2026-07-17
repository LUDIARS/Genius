import { EmbeddingError } from "./types.js";

export function validateVector(
  vector: readonly number[],
  dimension: number,
  label = "embedding",
): void {
  if (vector.length !== dimension) {
    throw new EmbeddingError(
      `${label} dimension mismatch: expected ${dimension}, received ${vector.length}`,
    );
  }
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index];
    if (value === undefined || !Number.isFinite(value)) {
      throw new EmbeddingError(`${label}[${index}] must be a finite number`);
    }
  }
}

export function encodeVector(vector: readonly number[], dimension: number): Buffer {
  validateVector(vector, dimension);
  const encoded = Buffer.allocUnsafe(dimension * Float32Array.BYTES_PER_ELEMENT);
  for (let index = 0; index < dimension; index += 1) {
    encoded.writeFloatLE(vector[index]!, index * Float32Array.BYTES_PER_ELEMENT);
  }
  return encoded;
}

export function decodeVector(encoded: Buffer, dimension: number): number[] {
  const expectedBytes = dimension * Float32Array.BYTES_PER_ELEMENT;
  if (encoded.byteLength !== expectedBytes) {
    throw new EmbeddingError(
      `Cached embedding byte length mismatch: expected ${expectedBytes}, received ${encoded.byteLength}`,
    );
  }
  const vector = new Array<number>(dimension);
  for (let index = 0; index < dimension; index += 1) {
    vector[index] = encoded.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT);
  }
  validateVector(vector, dimension, "cached embedding");
  return vector;
}
