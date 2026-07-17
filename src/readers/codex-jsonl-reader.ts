import { formatCodexTranscriptRecord } from "./jsonl-transcript.js";
import { TierTwoJsonlReader } from "./tier-two-jsonl-reader.js";

export class CodexJsonlReader extends TierTwoJsonlReader {
  public constructor(rootDirectory: string) {
    super("codex-jsonl", rootDirectory, formatCodexTranscriptRecord);
  }
}
