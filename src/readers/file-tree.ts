import { opendir, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { SourceReaderError } from "./reader-error.js";
import type { SourceName } from "./source-reader.js";

export interface FileEntry {
  readonly absolutePath: string;
  readonly locator: string;
  readonly mtimeMs: number;
  readonly sizeBytes: number;
}
export async function listFilesRecursively(
  source: SourceName,
  rootDirectory: string,
  accepts: (locator: string) => boolean,
): Promise<readonly FileEntry[]> {
  const root = resolve(rootDirectory);
  await assertDirectory(source, root);
  const files: FileEntry[] = [];

  async function visit(directory: string): Promise<void> {
    let handle;
    try {
      handle = await opendir(directory);
    } catch (error) {
      throw new SourceReaderError(source, `cannot open source directory: ${directory}`, {
        cause: error,
      });
    }

    const entries = [];
    try {
      for await (const entry of handle) {
        entries.push(entry);
      }
    } catch (error) {
      throw new SourceReaderError(source, `cannot enumerate source directory: ${directory}`, {
        cause: error,
      });
    }
    entries.sort((left, right) => compareText(left.name, right.name));

    for (const entry of entries) {
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const locator = normalizeLocator(relative(root, absolutePath));
      if (!accepts(locator)) {
        continue;
      }
      let fileStat;
      try {
        fileStat = await stat(absolutePath);
      } catch (error) {
        throw new SourceReaderError(source, `cannot stat source document: ${locator}`, {
          locator,
          cause: error,
        });
      }
      files.push({
        absolutePath,
        locator,
        mtimeMs: fileStat.mtimeMs,
        sizeBytes: fileStat.size,
      });
    }
  }

  await visit(root);
  return files;
}

export async function assertDirectory(source: SourceName, directory: string): Promise<void> {
  let directoryStat;
  try {
    directoryStat = await stat(directory);
  } catch (error) {
    throw new SourceReaderError(source, `source directory is unavailable: ${directory}`, {
      cause: error,
    });
  }
  if (!directoryStat.isDirectory()) {
    throw new SourceReaderError(source, `source path is not a directory: ${directory}`);
  }
}

export function resolveSourceFile(
  source: SourceName,
  rootDirectory: string,
  locator: string,
): string {
  if (locator.length === 0 || locator.includes("\0")) {
    throw new SourceReaderError(source, "document locator is invalid", { locator });
  }
  const root = resolve(rootDirectory);
  const absolutePath = resolve(root, ...locator.split("/"));
  const relativePath = relative(root, absolutePath);
  if (
    relativePath === ""
    || relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || resolve(root, relativePath) !== absolutePath
  ) {
    throw new SourceReaderError(source, "document locator escapes the source directory", {
      locator,
    });
  }
  return absolutePath;
}

export function normalizeLocator(value: string): string {
  return value.split(sep).join("/");
}

export function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
