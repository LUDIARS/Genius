import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Absolute path of the build-less SPA served under `/ui/`.
 *
 * Both `src/api/ui/` (tsx) and `dist/api/ui/` (compiled) sit three levels below
 * the repository root, so the same relative walk resolves the checked-in `ui/`
 * directory in either mode. The path is derived from this module's location
 * rather than `process.cwd()` so the service can be started from anywhere.
 */
export function resolveUiRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "ui");
}
