import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ClaudeCliDistillLlm } from "../../src/distill/claude-cli-llm.js";
import { OllamaDistillLlm } from "../../src/distill/ollama-llm.js";

describe("distillation backend readiness", () => {
  it("checks that the configured Claude executable can start", async () => {
    const available = new ClaudeCliDistillLlm({
      command: process.execPath,
      commandArgs: [resolve("test/fixtures/fake-claude.mjs")],
      cwd: process.cwd(),
      model: "test-model",
      sensitiveCheckModel: "test-sensitive-model",
    });
    await expect(available.assertReady()).resolves.toBeUndefined();

    const unavailable = new ClaudeCliDistillLlm({
      command: `missing-claude-${process.pid}`,
      cwd: process.cwd(),
      model: "test-model",
      sensitiveCheckModel: "test-sensitive-model",
    });
    await expect(unavailable.assertReady()).rejects.toThrow(/executable is unavailable/);
  });

  it("passes trusted Claude instructions separately from untrusted input", async () => {
    const backend = new ClaudeCliDistillLlm({
      command: process.execPath,
      commandArgs: [resolve("test/fixtures/fake-claude.mjs"), "--echo-request"],
      cwd: process.cwd(),
      model: "test-model",
      sensitiveCheckModel: "test-sensitive-model",
    });

    const raw = await backend.complete({
      purpose: "cards",
      systemPrompt: "trusted system instructions",
      prompt: "untrusted source instructions",
    });

    expect(JSON.parse(raw)).toEqual({
      systemPrompt: "trusted system instructions",
      prompt: "untrusted source instructions",
    });
  });

  it("checks the configured Ollama model before accepting work", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeDefined();
      return String(input).endsWith("/api/tags")
        ? Response.json({ models: [{ name: "gemma4:12b" }] })
        : Response.json({ message: { content: '{"ok":true}' } });
    });
    const backend = new OllamaDistillLlm({
      baseUrl: "http://127.0.0.1:11434",
      model: "gemma4:12b",
      fetch: fetchMock as typeof fetch,
    });

    await expect(backend.assertReady()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/api\/tags$/);
    expect(String(fetchMock.mock.calls[1]?.[0])).toMatch(/\/api\/chat$/);
  });

  it("fails a stalled Ollama completion at its explicit timeout", async () => {
    const backend = new OllamaDistillLlm({
      baseUrl: "http://127.0.0.1:11434",
      model: "gemma4:12b",
      timeoutMs: 10,
      fetch: (async (_input, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error("test fetch expected an abort signal");
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })) as typeof fetch,
    });

    await expect(backend.complete({
      purpose: "cards",
      systemPrompt: "trusted instructions",
      prompt: "private input",
    }))
      .rejects.toThrow("Ollama completion request failed");
  });

  it("sends Ollama system and user messages as separate roles", async () => {
    let requestBody: unknown;
    const backend = new OllamaDistillLlm({
      baseUrl: "http://127.0.0.1:11434",
      model: "gemma4:12b",
      fetch: (async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as unknown;
        return Response.json({ message: { content: '{"cards":[]}' } });
      }) as typeof fetch,
    });

    await backend.complete({
      purpose: "cards",
      systemPrompt: "trusted system instructions",
      prompt: "untrusted source instructions",
    });

    expect(requestBody).toMatchObject({
      messages: [
        { role: "system", content: "trusted system instructions" },
        { role: "user", content: "untrusted source instructions" },
      ],
    });
  });

  it("does not expose an Ollama error body in completion errors", async () => {
    const backend = new OllamaDistillLlm({
      baseUrl: "http://127.0.0.1:11434",
      model: "gemma4:12b",
      fetch: (async () => new Response("sensitive backend detail", { status: 500 })) as typeof fetch,
    });

    let failure: unknown;
    try {
      await backend.complete({
        purpose: "cards",
        systemPrompt: "trusted instructions",
        prompt: "private input",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Ollama completion request failed with HTTP 500");
    expect((failure as Error).message).not.toContain("sensitive backend detail");
    expect((failure as Error).message).not.toContain("private input");
  });
});
