/**
 * 絞り込み条件をキーへ畳む。値の区切りは長さ接頭辞にして、`a|b` と `a` + `|b` の
 * ような取り違えを起こさない。
 *
 * @implements SPEC-GENIUS-CARD-GROUP-CACHE
 */
export function cardGroupKey(parts: Record<string, unknown>): string {
  return Object.keys(parts)
    .sort()
    .map((name) => {
      const value = parts[name];
      const text = value === undefined ? "" : String(value);
      return `${name}:${text.length}:${text}`;
    })
    .join("|");
}
