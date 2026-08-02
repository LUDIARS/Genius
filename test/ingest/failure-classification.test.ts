import { describe, expect, it } from "vitest";
import { classifyIngestError } from "../../src/ingest/failure-classification.js";
import {
  DistillationBackendError,
  DistillationOutputError,
} from "../../src/distill/distill-errors.js";
import { SourceReaderError } from "../../src/readers/reader-error.js";

const SECRET_BODY = "SECRET-DOCUMENT-BODY";

describe("classifyIngestError (Memoria #694)", () => {
  it("keeps the managed message of a distillation backend failure", () => {
    const classified = classifyIngestError(
      new DistillationBackendError("Claude CLI failed (code=1, signal=null); stderr withheld"),
    );
    expect(classified).toEqual({
      kind: "processing-failed",
      message: "Claude CLI failed (code=1, signal=null); stderr withheld",
    });
  });

  it("keeps the bounded summary of a distillation output failure", () => {
    const classified = classifyIngestError(
      new DistillationOutputError(
        "Distillation returned invalid JSON after 3 attempts: SyntaxError(position 4) | ZodError(cards.0.category: invalid_enum_value)",
      ),
    );
    expect(classified.kind).toBe("distillation-output-invalid");
    expect(classified.message).toContain("after 3 attempts");
  });

  it("keeps the managed source reader message", () => {
    const classified = classifyIngestError(
      new SourceReaderError("review", "cannot read latest.json", { locator: "a/latest.json" }),
    );
    expect(classified).toEqual({
      kind: "source-read-failed",
      message: "[review] cannot read latest.json",
    });
  });

  it("redacts absolute paths from a managed message", () => {
    // listDocuments の失敗は設定由来の絶対パスを文言に含む
    // (src/readers/file-tree.ts `cannot open source directory: <root>`)。
    // これは通知・ログ・DB へ出るので basename だけに落とす。
    for (const root of ["C:\\Users\\someone\\Ars\\Review", "/home/someone/ars/review"]) {
      const { message } = classifyIngestError(
        new SourceReaderError("review", `cannot open source directory: ${root}`),
      );
      // ユーザ名・ディレクトリ構成は落ちるが、どこを読もうとしたかは残る。
      expect(message).not.toContain("someone");
      expect(message).toContain("cannot open source directory:");
      expect(message).toMatch(/…\/Review$/i);
    }
  });

  it("describes an unknown error without transcribing its message", () => {
    const error = new Error(`distillation blew up on: ${SECRET_BODY}`, {
      cause: new RangeError("boom"),
    });
    const classified = classifyIngestError(error);

    expect(classified.kind).toBe("processing-failed");
    expect(classified.message).not.toContain(SECRET_BODY);
    // 診断可能: クラス名 + cause 連鎖 + スタック先頭フレーム (ファイル名:行:列)。
    expect(classified.message).toContain("Error");
    expect(classified.message).toContain("cause=RangeError");
    expect(classified.message).toMatch(/at [^\s]+:\d+:\d+/);
    // 絶対パス (ドライブ文字・ディレクトリ区切り) を含まない。
    expect(classified.message).not.toMatch(/[A-Za-z]:[\\/]|\/home\/|\/Users\//);
  });

  it("includes the system error code when present", () => {
    const error = new Error("open failed") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    expect(classifyIngestError(error).message).toContain("code=ENOENT");
  });

  it("truncates oversized managed messages", () => {
    const classified = classifyIngestError(new DistillationBackendError("x".repeat(500)));
    expect(classified.message.length).toBeLessThanOrEqual(301);
    expect(classified.message.endsWith("…")).toBe(true);
  });
});
