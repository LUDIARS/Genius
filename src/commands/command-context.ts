import type { LoadedGeniusConfig } from "../config/types.js";

/** サブコマンド群に渡す共通の文脈。 */
export interface CommandContext {
  config: LoadedGeniusConfig;
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  stdout: (text: string) => void;
}

export function requiredOption(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`--${name} is required`);
  return trimmed;
}

export function optionalPositiveInteger(
  raw: string | undefined,
  name: string,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0 || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return Number(raw);
}
