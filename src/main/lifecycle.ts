/** Defer the first quit before windows close; allow the second quit after cleanup. */
export function cleanupOnQuit(
  app: {
    on(event: "before-quit", listener: (event: { preventDefault(): void }) => void): unknown;
    quit(): void;
  },
  cleanup: () => Promise<void>,
  reportError: (error: unknown) => void,
) {
  let state: "running" | "disposing" | "disposed" = "running";
  app.on("before-quit", (event) => {
    if (state === "disposed") return;
    event.preventDefault();
    if (state === "disposing") return;
    state = "disposing";
    void cleanup()
      .catch(reportError)
      .finally(() => {
        state = "disposed";
        app.quit();
      });
  });
}
