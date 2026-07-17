import { ConfigError } from "./errors.js";
import {
  SOURCE_CONFIG_KEYS,
  type GeniusConfig,
  type SourceName,
  type SourceResolution,
} from "./types.js";

export function resolveConfiguredSources(
  config: GeniusConfig,
  requested: readonly SourceName[],
  allowMissing: boolean,
): SourceResolution {
  const configured: SourceResolution["configured"] = [];
  const skipped: SourceName[] = [];

  for (const name of requested) {
    const configKey = SOURCE_CONFIG_KEYS[name];
    const location = config.sources[configKey];
    if (location === null) {
      if (!allowMissing) {
        throw new ConfigError(
          `Source "${name}" is not configured (${configKey} is null). ` +
            "Set it in genius.config.json or pass --allow-missing.",
        );
      }
      skipped.push(name);
      continue;
    }
    configured.push({ name, location });
  }

  return { configured, skipped };
}
