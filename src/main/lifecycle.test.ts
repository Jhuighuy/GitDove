import { expect, it, vi } from "vitest";
import { cleanupOnQuit } from "./lifecycle";

it("cleans up once, then lets Electron complete a normal quit", async () => {
  let onQuit!: (event: { preventDefault(): void }) => void;
  const app = {
    on: (_event: string, handler: typeof onQuit) => {
      onQuit = handler;
    },
    quit: vi.fn(),
  };
  let done!: () => void;
  const cleanup = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        done = resolve;
      }),
  );
  const report = vi.fn();
  cleanupOnQuit(app, cleanup, report);
  const event = { preventDefault: vi.fn() };
  onQuit(event);
  onQuit(event);
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
  expect(cleanup).toHaveBeenCalledOnce();
  expect(app.quit).not.toHaveBeenCalled();
  done();
  await Promise.resolve();
  await Promise.resolve();
  expect(app.quit).toHaveBeenCalledOnce();
  event.preventDefault.mockClear();
  onQuit(event);
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
});

it("still exits when cleanup fails", async () => {
  let onQuit!: (event: { preventDefault(): void }) => void;
  const app = {
    on: (_event: string, handler: typeof onQuit) => {
      onQuit = handler;
    },
    quit: vi.fn(),
  };
  const error = new Error("SSH cleanup failed");
  const report = vi.fn();
  cleanupOnQuit(
    app,
    async () => {
      throw error;
    },
    report,
  );
  onQuit({ preventDefault: vi.fn() });
  await Promise.resolve();
  await Promise.resolve();
  expect(report).toHaveBeenCalledWith(error);
  expect(app.quit).toHaveBeenCalledOnce();
});
