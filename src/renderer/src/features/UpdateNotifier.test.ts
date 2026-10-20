import { beforeEach, expect, it, vi } from "vitest";
import type { UpdaterStatus } from "@shared/domain";

const mocks = vi.hoisted(() => ({
  effects: [] as (() => void)[],
  event: null as null | ((status: UpdaterStatus) => void),
  api: vi.fn(),
  info: vi.fn(),
}));
vi.mock("react", () => ({
  useRef: (value: unknown) => ({ current: value }),
  useCallback: (callback: unknown) => callback,
  useEffect: (callback: () => void) => mocks.effects.push(callback),
}));
vi.mock("sonner", () => ({ toast: { info: mocks.info } }));
vi.mock("@/lib/api", () => ({
  api: mocks.api,
  useEvent: (_event: string, callback: (status: UpdaterStatus) => void) => {
    mocks.event = callback;
  },
}));
import { UpdateNotifier } from "./UpdateNotifier";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.effects = [];
  mocks.event = null;
});

it("shows an update that was already ready before the renderer subscribed", async () => {
  mocks.api.mockResolvedValue({ kind: "ready", version: "1.0.2" });
  expect(UpdateNotifier()).toBeNull();
  mocks.effects[0]!();
  await Promise.resolve();
  expect(mocks.info).toHaveBeenCalledWith(
    "GitDove 1.0.2 is ready",
    expect.objectContaining({ duration: Infinity }),
  );
  mocks.info.mock.calls[0]![1].action.onClick();
  expect(mocks.api).toHaveBeenLastCalledWith("updater.install");
});

it("deduplicates notifications and ignores incomplete downloads", async () => {
  mocks.api.mockResolvedValue({ kind: "idle" });
  UpdateNotifier();
  mocks.effects[0]!();
  await Promise.resolve();
  mocks.event!({ kind: "downloading", percent: 50 });
  expect(mocks.info).not.toHaveBeenCalled();
  mocks.event!({ kind: "ready", version: "1.0.2" });
  mocks.event!({ kind: "ready", version: "1.0.2" });
  expect(mocks.info).toHaveBeenCalledTimes(1);
  mocks.event!({ kind: "ready", version: "1.0.3" });
  expect(mocks.info).toHaveBeenCalledTimes(2);
});

it("does not show a stale snapshot after a newer status event", async () => {
  let finish!: (status: UpdaterStatus) => void;
  mocks.api.mockReturnValue(
    new Promise<UpdaterStatus>((resolve) => {
      finish = resolve;
    }),
  );
  UpdateNotifier();
  mocks.effects[0]!();
  mocks.event!({ kind: "ready", version: "1.0.3" });
  finish({ kind: "ready", version: "1.0.2" });
  await Promise.resolve();
  expect(mocks.info).toHaveBeenCalledTimes(1);
  expect(mocks.info).toHaveBeenCalledWith("GitDove 1.0.3 is ready", expect.anything());
});

it("handles the main process being unavailable during startup", async () => {
  mocks.api.mockRejectedValue(new Error("closed"));
  UpdateNotifier();
  mocks.effects[0]!();
  await Promise.resolve();
  await Promise.resolve();
  expect(mocks.info).not.toHaveBeenCalled();
});
