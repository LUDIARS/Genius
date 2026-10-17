import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/config/errors.js";
import { catalogServicePort } from "../../src/elegantia/catalog-port.js";

// Synthetic catalog fragment shaped like <repo>/excubitor.catalog.yaml.
const CATALOG = [
  "# fixture catalog",
  "services:",
  "  - code: other",
  "    port: 1111",
  "  - name: Fixture Elegantia",
  "    code: \"elegantia\"   # quoted value with a comment",
  "    port: 17999",
  "    health:",
  "      type: http",
  "      port: 2222",
  "    env:",
  "      - port: 3333",
  "",
].join("\r\n");

describe("catalogServicePort", () => {
  it("reads the item-level port of the requested service, ignoring nested keys", () => {
    expect(catalogServicePort(CATALOG, "elegantia")).toBe(17999);
    expect(catalogServicePort(CATALOG, "other")).toBe(1111);
  });

  it("fails loudly when the service, its port or the list is missing", () => {
    expect(() => catalogServicePort(CATALOG, "absent")).toThrow(ConfigError);
    expect(() => catalogServicePort("services:\n  - code: elegantia\n", "elegantia"))
      .toThrow(/has no port/);
    expect(() => catalogServicePort("other: 1\n", "elegantia")).toThrow(/no top-level services/);
  });

  it("rejects duplicated, non-numeric and out-of-range ports instead of guessing", () => {
    const duplicated = "services:\n  - code: elegantia\n    port: 1\n  - code: elegantia\n    port: 2\n";
    expect(() => catalogServicePort(duplicated, "elegantia")).toThrow(/more than once/);
    expect(() => catalogServicePort("services:\n  - code: elegantia\n    port: ${PORT}\n", "elegantia"))
      .toThrow(/non-numeric/);
    expect(() => catalogServicePort("services:\n  - code: elegantia\n    port: 70000\n", "elegantia"))
      .toThrow(/out-of-range/);
  });

  it("stops at the next top-level key", () => {
    const text = "services:\n  - code: a\n    port: 10\nextra:\n  - code: elegantia\n    port: 20\n";
    expect(() => catalogServicePort(text, "elegantia")).toThrow(/no service/);
  });
});
