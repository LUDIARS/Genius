import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `dist/` が `src/` のビルド後に生成されたかを確認する。
 *
 * 背景: `dist/ingest/*.js` に `progress()` 反映 fix (commit 3313e33/4152037,
 * 2026-08-26) をマージした後も、Excubitor 常駐プロセスは `npm run build` を
 * 再実行されないまま起動し続け、ingest run の filesProcessed が実際には
 * 進んでいるのに API 上ずっと 0 に見える「表示バグの再発」が発生した
 * (2026-08-29 run 01M17EW8CHDEZA7C2FEYAZ21NP で確認)。原因は fix 自体の
 * 不備ではなく `dist/` の再ビルド漏れであり、コードからは検知できなかった。
 *
 * `restart_policy: on-failure` の Excubitor 管理下では、ソース変更だけでは
 * プロセスは再起動されない (クラッシュ時のみ再起動) ため、ビルド漏れは
 * サービスを止めずに静かに古いロジックを動かし続ける。
 *
 * @implements SPEC-GENIUS-BUILD-FRESHNESS
 */
export interface BuildFreshnessResult {
  readonly stale: boolean;
  /** 最初に見つかった「出力が無い、または src の方が新しい」ファイルの相対パス。 */
  readonly staleSample: string | null;
}

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const DIST_DIR = fileURLToPath(new URL("../../dist", import.meta.url));

/**
 * `src/**\/*.ts` のうち対応する `dist/**\/*.js` が無いか、mtime が新しいものを探す。
 * dist が丸ごと無い (ビルド未実行) 場合は stale 判定しない — それは
 * 別のエラー (起動できない) として顕在化するため、ここでは静かに false を返す。
 */
export async function checkBuildFreshness(
  srcDir: string = SRC_DIR,
  distDir: string = DIST_DIR,
): Promise<BuildFreshnessResult> {
  if (await statIfExists(distDir) === null) {
    return { stale: false, staleSample: null };
  }

  const srcFiles = await listFiles(srcDir);
  for (const srcFile of srcFiles) {
    if (!srcFile.endsWith(".ts") || srcFile.endsWith(".d.ts")) continue;
    const relPath = relative(srcDir, srcFile);
    const distFile = join(distDir, relPath.replace(/\.ts$/, ".js"));
    const [srcStat, distStat] = await Promise.all([
      stat(srcFile),
      statIfExists(distFile),
    ]);
    if (distStat === null || srcStat.mtimeMs > distStat.mtimeMs) {
      return { stale: true, staleSample: relPath };
    }
  }
  return { stale: false, staleSample: null };
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

async function statIfExists(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function formatBuildFreshnessWarning(result: BuildFreshnessResult): string {
  return (
    `[build] dist/ appears stale (source newer than or missing from build output; e.g. ${String(result.staleSample)}). ` +
    "Run `npm run build` and restart this service — running code may not match main."
  );
}
