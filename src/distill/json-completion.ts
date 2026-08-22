import { ZodError, type ZodType } from "zod";
import type { DistillCompletionRequest, DistillLlm } from "./distill-llm.js";
import { DistillationOutputError } from "./distill-errors.js";

const MAX_RETRIES = 2;
const MAX_ZOD_ISSUES = 5;

/**
 * LLM 出力から JSON 候補を抽出する。モデルはフェンスの前後に解説文を
 * 付けることがある (2026-07-31 の channel-archives 482 件失敗の実原因) ため、
 * 「全体がフェンス」に限定せず、次の順で候補を試す:
 *   1. trim した全体
 *   2. 出力中の最初の ```json フェンスの中身
 *   3. 最初の `{` / `[` から括弧の対応が取れる位置まで
 *
 * 3 は `{` 起点と `[` 起点を独立に試す。解説文が「以下 [参考] の通り」の
 * ように括弧を含むと、最初に現れる括弧が JSON の開始とは限らないため。
 * 対応取りにするのは、JSON の後ろに続く解説文が括弧を含むと「最後の `}`」
 * では解説文まで巻き込んでしまうため。
 */
function jsonCandidates(raw: string): string[] {
  const trimmed = raw.trim();
  const candidates = [trimmed];
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed);
  if (fence?.[1]) candidates.push(fence[1]);
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const balanced = balancedSlice(trimmed, open, close);
    if (balanced !== null) candidates.push(balanced);
  }
  return candidates;
}

/**
 * 最初の `open` から括弧の対応が閉じる位置までを切り出す。JSON 文字列
 * リテラル内の括弧・エスケープは数えない。閉じなければ null。
 */
function balancedSlice(text: string, open: "{" | "[", close: "}" | "]"): string | null {
  const start = text.indexOf(open);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function parseFirstCandidate(raw: string): unknown {
  let lastError: unknown = new SyntaxError("output contains no JSON");
  for (const candidate of jsonCandidates(raw)) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * parse / validation 失敗を LLM 出力を転記せずに要約する。
 * SyntaxError はエラー名 + position のみ、ZodError は issue の code と path のみ。
 */
function summarizeAttemptFailure(error: unknown): string {
  if (error instanceof ZodError) {
    const issues = error.issues
      .slice(0, MAX_ZOD_ISSUES)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
      .join(", ");
    const suffix = error.issues.length > MAX_ZOD_ISSUES ? ", …" : "";
    return `ZodError(${issues}${suffix})`;
  }
  if (error instanceof SyntaxError) {
    const position = /position (\d+)/.exec(error.message)?.[1];
    return position === undefined ? "SyntaxError" : `SyntaxError(position ${position})`;
  }
  return error instanceof Error ? error.name : "UnknownError";
}

/**
 * ZodError の issue を「同じ誤りを正す」ための具体的な指示文へ落とす。
 * LLM 出力そのものは転記しない (issue の path/code/受理値一覧のみ) — 2026-08-21
 * の review ソース全滅 (25/25 が category enum 違反を 3 回連続で再送) の原因は
 * リトライが直前と同一の request を再送するだけで、何が無効だったかを
 * フィードバックしていなかったこと。
 */
function correctionHint(error: unknown): string | null {
  if (!(error instanceof ZodError)) return null;
  // 配列要素ごとに同じ enum 違反が出る (cards.0.category, cards.1.category, …) のが
  // 実際の失敗形なので、指示文が同一のものは畳む。受理値一覧を要素数だけ
  // 繰り返すとプロンプトが膨らむだけで、モデルに伝わる情報は増えない。
  const hints = new Set<string>();
  for (const issue of error.issues.slice(0, MAX_ZOD_ISSUES)) {
    const path = issue.path.join(".") || "(root)";
    if (issue.code === "invalid_value") {
      const allowed = issue.values.map((value) => JSON.stringify(value)).join(", ");
      hints.add(
        `Every ${genericPath(path)} must be exactly one of: ${allowed}. ` +
          "Do not invent a value outside this list.",
      );
      continue;
    }
    hints.add(`${path}: ${issue.code}`);
  }
  return hints.size === 0 ? null : [...hints].join(" ");
}

/** `cards.3.category` → `cards[].category` — 要素番号を落として指示文を畳めるようにする。 */
function genericPath(path: string): string {
  return path.replace(/\.\d+(?=\.|$)/g, "[]");
}

/** 訂正指示を付けた request を新たに作る (元の request は変更しない)。 */
function withCorrectionHint(
  request: DistillCompletionRequest,
  hint: string,
): DistillCompletionRequest {
  return {
    ...request,
    systemPrompt:
      `${request.systemPrompt}\n\n` +
      "Your previous reply did not satisfy the required schema: " +
      `${hint} Reply again with the full corrected JSON, following the rules above.`,
  };
}

export async function requestValidatedJson<T>(
  llm: DistillLlm,
  request: DistillCompletionRequest,
  schema: ZodType<T>,
): Promise<T> {
  const failures: string[] = [];
  // 直前の試行に対する訂正指示だけを載せる。SyntaxError には schema 由来の
  // 訂正材料が無いので null に戻し、無関係になった前回の hint を引きずらない。
  let hint: string | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const raw = await llm.complete(hint === null ? request : withCorrectionHint(request, hint));
    try {
      const parsed: unknown = parseFirstCandidate(raw);
      return schema.parse(parsed);
    } catch (error) {
      failures.push(summarizeAttemptFailure(error));
      hint = correctionHint(error);
    }
  }

  throw new DistillationOutputError(
    `Distillation returned invalid JSON after ${MAX_RETRIES + 1} attempts: ${failures.join(" | ")}`,
  );
}
