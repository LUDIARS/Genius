export async function closeServerAndRuntime(
  closeServer: () => Promise<void>,
  closeRuntime: () => Promise<void>,
): Promise<void> {
  try {
    await closeServer();
  } catch (serverError) {
    try {
      await closeRuntime();
    } catch (runtimeError) {
      throw new AggregateError(
        [serverError, runtimeError],
        "Server and Genius runtime shutdown both failed",
      );
    }
    throw serverError;
  }
  await closeRuntime();
}
