import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { IngestLogEntry, IngestLogger } from "./ingest-contracts.js";

/** ログ 1 行の書き込みに許す上限。超えたらそのエントリを諦めて run を進める。 */
const DEFAULT_APPEND_TIMEOUT_MS = 5_000;

export interface JsonlIngestLoggerOptions {
  appendTimeoutMs?: number;
  warningSink?: (message: string) => void;
  /** テスト用の書き込み差し替え。既定は mkdir + appendFile。 */
  writeLine?: (path: string, line: string) => Promise<void>;
}

async function defaultWriteLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, line, { encoding: "utf8", flag: "a" });
}

/**
 * logs/ingest.jsonl への追記 logger。
 *
 * ファイル I/O が永久待ちになる劣化ウィンドウ (Memoria #735 — appendFile が
 * 返らず retry run が 19 時間停滞) に備え、書き込みはタイムアウト付きで待つ。
 * 時間切れ・失敗はエントリを破棄して warningSink へ明示し (無言で捨てない)、
 * 呼び出し側の ingest 進行は止めない。詰まった書き込みが直列チェーンを
 * 塞がないよう、チェーンはタイムアウトを解決として前進する。
 */
export class JsonlIngestLogger implements IngestLogger {
  readonly #path: string;
  readonly #appendTimeoutMs: number;
  readonly #warningSink: (message: string) => void;
  readonly #writeLine: (path: string, line: string) => Promise<void>;
  #pending: Promise<void> = Promise.resolve();

  constructor(path: string, options: JsonlIngestLoggerOptions = {}) {
    this.#path = path;
    this.#appendTimeoutMs = options.appendTimeoutMs ?? DEFAULT_APPEND_TIMEOUT_MS;
    this.#warningSink =
      options.warningSink ?? ((message) => process.stderr.write(`${message}\n`));
    this.#writeLine = options.writeLine ?? defaultWriteLine;
  }

  append(entry: IngestLogEntry): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`;
    this.#pending = this.#pending.then(() => this.#writeBounded(line, entry.event));
    return this.#pending;
  }

  async #writeBounded(line: string, event: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.#appendTimeoutMs);
      timer.unref?.();
    });
    try {
      const write = this.#writeLine(this.#path, line).then(() => "written" as const);
      // タイムアウト後も write 自体は打ち切れない (fs API に cancel は無い) が、
      // 以後の append と ingest 本体はこの write を待たずに進む。宙に残った
      // write の失敗はここで捕捉して警告だけ出す (unhandled rejection 防止)。
      const outcome = await Promise.race([write, timedOut]);
      if (outcome === "timeout") {
        this.#warningSink(
          `Ingest log append timed out after ${this.#appendTimeoutMs}ms; dropped entry (${event})`,
        );
        write.catch((error: unknown) => {
          const name = error instanceof Error ? error.name : "UnknownError";
          this.#warningSink(`Ingest log append failed after timeout (${event}): ${name}`);
        });
        return;
      }
    } catch (error) {
      const name = error instanceof Error ? error.name : "UnknownError";
      this.#warningSink(`Ingest log append failed; dropped entry (${event}): ${name}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
