// @vitest-environment happy-dom
import type { UpdaterStatus } from "@shared/domain";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { UpdateNotifier } from "./UpdateNotifier";

const mocks = vi.hoisted(() => ({
  status: { kind: "idle" } as UpdaterStatus,
  listener: null as null | ((s: UpdaterStatus) => void),
  api: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { info: mocks.toast } }));
vi.mock("@/lib/api", () => ({
  api: mocks.api,
  useEvent: (_event: string, listener: (s: UpdaterStatus) => void) => {
    mocks.listener = listener;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.api.mockImplementation(async (method: string) =>
    method === "updater.status" ? mocks.status : undefined,
  );
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

async function render() {
  await act(async () => createRoot(document.createElement("div")).render(<UpdateNotifier />));
}

it("shows an update that was ready before the window loaded", async () => {
  mocks.status = { kind: "ready", version: "0.1.6" };
  await render();
  expect(mocks.toast).toHaveBeenCalledWith(
    "GitDove 0.1.6 is ready",
    expect.objectContaining({ duration: Infinity }),
  );
  mocks.toast.mock.calls[0]?.[1].action.onClick();
  expect(mocks.api).toHaveBeenLastCalledWith("updater.install");
});

it("shows each downloaded version once", async () => {
  mocks.status = { kind: "idle" };
  await render();
  expect(mocks.toast).not.toHaveBeenCalled();
  act(() => mocks.listener?.({ kind: "downloading", percent: 50 }));
  act(() => mocks.listener?.({ kind: "ready", version: "0.1.6" }));
  act(() => mocks.listener?.({ kind: "ready", version: "0.1.6" }));
  expect(mocks.toast).toHaveBeenCalledTimes(1);
  act(() => mocks.listener?.({ kind: "ready", version: "0.1.7" }));
  expect(mocks.toast).toHaveBeenCalledTimes(2);
});
