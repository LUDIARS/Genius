/** Genius 自身の HTTP API を叩く CLI 用の小さな JSON 要求 (失敗は HTTP status ごと投げる)。 */
export async function requestJson(
  url: URL,
  fetchImplementation: typeof globalThis.fetch,
  init: RequestInit,
): Promise<unknown> {
  const response = await fetchImplementation(url, { ...init, redirect: "error" });
  if (!response.ok) {
    throw new Error(`Genius API request failed with HTTP ${response.status}`);
  }
  const body = await response.text();
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new Error("Genius API returned invalid JSON", { cause: error });
  }
}
