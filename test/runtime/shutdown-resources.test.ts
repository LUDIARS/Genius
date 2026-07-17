import { describe, expect, it, vi } from "vitest";
import { closeServerAndRuntime } from "../../src/runtime/shutdown-resources.js";

describe("closeServerAndRuntime", () => {
  it("always closes the runtime when server closure fails", async () => {
    const serverError = new Error("server close failed");
    const closeRuntime = vi.fn(async () => undefined);

    await expect(
      closeServerAndRuntime(
        async () => { throw serverError; },
        closeRuntime,
      ),
    ).rejects.toBe(serverError);
    expect(closeRuntime).toHaveBeenCalledOnce();
  });

  it("preserves both failures when server and runtime closure fail", async () => {
    const serverError = new Error("server close failed");
    const runtimeError = new Error("runtime close failed");

    await expect(
      closeServerAndRuntime(
        async () => { throw serverError; },
        async () => { throw runtimeError; },
      ),
    ).rejects.toMatchObject({
      name: "AggregateError",
      errors: [serverError, runtimeError],
    });
  });
});
