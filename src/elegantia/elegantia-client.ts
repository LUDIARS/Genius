import { z } from "zod";
import { normalizeLoopbackHttpUrl } from "../config/loopback-url.js";
import type { ElegantiaAntipatternInput } from "./antipattern-payload.js";

const registrationResponseSchema = z.object({
  id: z.string().min(1),
  created: z.boolean(),
});

export type ElegantiaRegistration = z.infer<typeof registrationResponseSchema>;

export interface ElegantiaAntipatternSink {
  /** 到達不能・2xx 以外・応答不正は throw する (失敗を握りつぶさない)。 */
  register(input: ElegantiaAntipatternInput): Promise<ElegantiaRegistration>;
}

export interface ElegantiaClientOptions {
  /** loopback のみ (Elegantia の POST は 127.0.0.1 からしか受け付けない)。 */
  baseUrl: string;
  timeoutMs: number;
  fetch?: typeof globalThis.fetch;
}

/** Elegantia への登録失敗。カード本文・応答本文は載せない (HTTP status のみ)。 */
export class ElegantiaRequestError extends Error {
  override readonly name = "ElegantiaRequestError";
}

/**
 * `POST /api/antipatterns` のクライアント。
 *
 * Elegantia は同じ sourceRef を冪等に扱う (201 = 新規 / 200 = 既存) ので、
 * outbox の再送で二重登録にはならない。
 */
export class ElegantiaClient implements ElegantiaAntipatternSink {
  readonly #url: URL;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: ElegantiaClientOptions) {
    const baseUrl = normalizeLoopbackHttpUrl(options.baseUrl, "elegantia baseUrl");
    this.#url = new URL("/api/antipatterns", baseUrl);
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async register(input: ElegantiaAntipatternInput): Promise<ElegantiaRegistration> {
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new ElegantiaRequestError(`Elegantia ${this.#url.pathname} is unreachable`, {
        cause: error,
      });
    }
    if (response.status !== 200 && response.status !== 201) {
      await response.body?.cancel();
      throw new ElegantiaRequestError(
        `Elegantia ${this.#url.pathname} answered HTTP ${response.status}`,
      );
    }
    let decoded: unknown;
    try {
      decoded = await response.json();
    } catch (error) {
      throw new ElegantiaRequestError(`Elegantia ${this.#url.pathname} returned invalid JSON`, {
        cause: error,
      });
    }
    const parsed = registrationResponseSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new ElegantiaRequestError(
        `Elegantia ${this.#url.pathname} returned an unexpected response shape`,
      );
    }
    return parsed.data;
  }
}
