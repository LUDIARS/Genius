import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { IngestLogEntry, IngestLogger } from "./ingest-contracts.js";

export class JsonlIngestLogger implements IngestLogger {
  readonly #path: string;
  #pending: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  append(entry: IngestLogEntry): Promise<void> {
    this.#pending = this.#pending.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      await appendFile(this.#path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", flag: "a" });
    });
    return this.#pending;
  }
}
