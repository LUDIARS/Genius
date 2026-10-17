import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { catalogServicePort } from "../elegantia/catalog-port.js";
import { ConfigError } from "./errors.js";
import type { ElegantiaConfig } from "./types.js";

/** Excubitor catalog 上の Elegantia のサービスコード (Elegantia API 契約)。 */
export const ELEGANTIA_SERVICE_CODE = "elegantia";

export interface RawElegantiaConfig {
  enabled: boolean;
  catalogPath: string | null;
  threshold: number;
  timeoutMs: number;
  maxPerRun: number;
}

/**
 * genius.config.json の `elegantia` 節を、送り先 URL まで解決する。
 *
 * ポートの正本は Elegantia リポの Excubitor catalog 断片なので、config には
 * 番号を書かせず catalog から読む (port-source-rule)。catalogPath 省略時は
 * `${ARS_ROOT}/Elegantia/excubitor.catalog.yaml` (Genius の config がある
 * `${ARS_ROOT}/Genius` の隣)。有効なのに catalog が読めない・Elegantia の
 * エントリが無いときは起動時に落とす (無言で連携を止めない)。
 */
export function resolveElegantiaConfig(
  raw: RawElegantiaConfig,
  configPath: string,
): ElegantiaConfig {
  const tuning = { threshold: raw.threshold, timeoutMs: raw.timeoutMs, maxPerRun: raw.maxPerRun };
  if (!raw.enabled) return { baseUrl: null, catalogPath: null, ...tuning };

  const configDirectory = dirname(configPath);
  const catalogPath =
    raw.catalogPath === null
      ? resolve(configDirectory, "..", "Elegantia", "excubitor.catalog.yaml")
      : isAbsolute(raw.catalogPath)
        ? raw.catalogPath
        : resolve(configDirectory, raw.catalogPath);
  if (!existsSync(catalogPath)) {
    throw new ConfigError(
      `elegantia.enabled is true but the Excubitor catalog was not found: ${catalogPath}`,
    );
  }
  let text: string;
  try {
    text = readFileSync(catalogPath, "utf8");
  } catch (error) {
    throw new ConfigError(`Failed to read Excubitor catalog: ${catalogPath}`, { cause: error });
  }
  let port: number;
  try {
    port = catalogServicePort(text, ELEGANTIA_SERVICE_CODE);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`${detail} (${catalogPath})`, { cause: error });
  }
  return { baseUrl: `http://127.0.0.1:${port}`, catalogPath, ...tuning };
}
