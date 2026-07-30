import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

export interface StaticAsset {
  /** File bytes, ready to hand to a Response body. */
  body: ArrayBuffer;
  contentType: string;
}

/**
 * Extensions the UI directory may serve, with their response media type.
 * Anything outside this whitelist is not served even if the file exists, so a
 * stray `.db`, `.json` dump or `.ts` source under `ui/` can never leak
 * (spec/feature/operations.md Section 5).
 */
const ALLOWED_EXTENSIONS = new Map<string, string>([
  ["html", "text/html; charset=utf-8"],
  ["css", "text/css; charset=utf-8"],
  ["js", "text/javascript; charset=utf-8"],
  ["mjs", "text/javascript; charset=utf-8"],
  ["svg", "image/svg+xml"],
  ["ico", "image/x-icon"],
]);

const INDEX_FILE = "index.html";

/** Errors that mean "no such asset" rather than a broken installation. */
const MISSING_FILE_CODES = new Set(["ENOENT", "ENOTDIR", "EISDIR", "EACCES", "ERR_INVALID_ARG_VALUE"]);

/**
 * Reads files from a single directory for a request path, refusing anything
 * that could escape that directory. Traversal is rejected on the request path
 * itself (`..`, absolute paths, backslashes, NUL) and the resolved path is
 * re-checked against the root as defence in depth.
 */
export class StaticAssetDirectory {
  readonly #root: string;

  public constructor(root: string) {
    this.#root = resolve(root);
  }

  /**
   * Returns the asset for a request path relative to the directory root, or
   * `null` when the path is unservable (rejected shape, extension outside the
   * whitelist, or no such file). Unexpected I/O failures are rethrown.
   */
  public async read(requestPath: string): Promise<StaticAsset | null> {
    const relativePath = normalizeRequestPath(requestPath);
    if (relativePath === null) return null;
    const contentType = contentTypeFor(relativePath);
    if (contentType === undefined) return null;
    const absolutePath = resolve(this.#root, relativePath);
    if (!isInsideRoot(absolutePath, this.#root)) return null;
    try {
      return { body: toArrayBuffer(await readFile(absolutePath)), contentType };
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  }
}

/**
 * Turns a request path into a safe root-relative path, or `null` if it must not
 * be served. A directory-style path maps to `index.html`.
 */
function normalizeRequestPath(requestPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    // Malformed percent-encoding cannot address a file; treat it as absent.
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  if (isAbsolute(decoded) || /^[A-Za-z]:/.test(decoded)) return null;
  const rawSegments = decoded.replace(/^\/+/, "").split("/");
  // A trailing slash (or an empty path) addresses the directory index.
  const isDirectoryPath = rawSegments[rawSegments.length - 1] === "";
  const segments = isDirectoryPath ? rawSegments.slice(0, -1) : rawSegments;
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return [...segments, ...(isDirectoryPath ? [INDEX_FILE] : [])].join("/");
}

function contentTypeFor(relativePath: string): string | undefined {
  const lastDot = relativePath.lastIndexOf(".");
  if (lastDot <= 0) return undefined;
  return ALLOWED_EXTENSIONS.get(relativePath.slice(lastDot + 1).toLowerCase());
}

function isInsideRoot(absolutePath: string, root: string): boolean {
  return absolutePath === root || absolutePath.startsWith(`${root}${sep}`);
}

/**
 * Copies out of the (possibly pooled) Node buffer so the response body owns a
 * standalone ArrayBuffer.
 */
function toArrayBuffer(buffer: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(buffer);
  return copy;
}

function isMissingFileError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code !== undefined && MISSING_FILE_CODES.has(code);
}
