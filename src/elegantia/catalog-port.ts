import { ConfigError } from "../config/errors.js";
import { contract } from '../contract-runtime.js'; /* augur-inject:import:5ba35f26 */
import augurContract_ab5a9e46 from '../contracts/catalog-port.contract.js'; /* augur-inject:contract-predicate:e25e576a */

const SERVICES_HEADER = /^services:\s*(#.*)?$/;
const LIST_ITEM = /^(\s*)-\s+(.*)$/;
const KEY_VALUE = /^([A-Za-z_][\w-]*):\s*(.*)$/;

/**
 * Excubitor catalog 断片 (`<repo>/excubitor.catalog.yaml`) から、指定 code の
 * サービスの port を読む。
 *
 * ポートの正本は catalog なので、Genius 側に番号を持たない (port-source-rule)。
 * Genius は YAML 依存を持たないため、catalog の `services:` 配下の
 * 「リスト項目直下のスカラー」だけを読む限定パーサにしている。項目内の入れ子
 * (health.url 等) は字下げで区別して読まない。読めない形・見つからない・
 * 重複は推測せず ConfigError で落とす (無言フォールバック禁止)。
 */
export function catalogServicePort(catalogText: string, code: string): number {
  const matches = readServiceItems(catalogText).filter((item) => item.get("code") === code);
  if (matches.length === 0) {
    throw new ConfigError(`Excubitor catalog has no service with code "${code}"`);
  }
  if (matches.length > 1) {
    throw new ConfigError(`Excubitor catalog declares service "${code}" more than once`);
  }
  const raw = matches[0]?.get("port");
  if (raw === undefined) {
    throw new ConfigError(`Excubitor catalog service "${code}" has no port`);
  }
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`Excubitor catalog service "${code}" has a non-numeric port`);
  }
  const port = Number(raw);
  if (port < 1 || port > 65_535) {
    throw new ConfigError(`Excubitor catalog service "${code}" has an out-of-range port`);
  }
  return port;
}
// @ts-expect-error augur-inject
catalogServicePort = contract(catalogServicePort, { ...augurContract_ab5a9e46, contractId: 'C-8', mode: 'observe', sample: 1, where: 'src/elegantia/catalog-port.ts:17', rule: 'contract-wrap', id: 'ab5a9e46' }); /* augur-inject:contract-wrap:ab5a9e46 */

function readServiceItems(catalogText: string): Map<string, string>[] {
  const lines = catalogText.split(/\r?\n/);
  const start = lines.findIndex((line) => SERVICES_HEADER.test(line));
  if (start < 0) throw new ConfigError("Excubitor catalog has no top-level services list");

  const items: Map<string, string>[] = [];
  let listIndent: number | null = null;
  let keyIndent = -1;
  let current: Map<string, string> | null = null;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break;
    const item = LIST_ITEM.exec(line);
    if (item !== null && (listIndent === null || indent === listIndent)) {
      listIndent = indent;
      keyIndent = indent + 2;
      current = new Map();
      items.push(current);
      addScalar(current, item[2] ?? "");
      continue;
    }
    if (current !== null && indent === keyIndent) addScalar(current, line.trim());
  }
  return items;
}

function addScalar(target: Map<string, string>, text: string): void {
  const match = KEY_VALUE.exec(text);
  if (match === null) return;
  const value = stripQuotes(stripComment(match[2] ?? "").trim());
  if (value !== "") target.set(match[1] ?? "", value);
}

function stripComment(value: string): string {
  const index = value.search(/\s#/);
  return index < 0 ? value : value.slice(0, index);
}

function stripQuotes(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted === null ? value : (quoted[2] ?? "");
}
