import { formatClaudeTranscriptRecord } from "./jsonl-transcript.js";
import { TierTwoJsonlReader } from "./tier-two-jsonl-reader.js";

export class ClaudeJsonlReader extends TierTwoJsonlReader {
  public constructor(rootDirectory: string) {
    super("claude-jsonl", rootDirectory, formatClaudeTranscriptRecord);
  }
}
