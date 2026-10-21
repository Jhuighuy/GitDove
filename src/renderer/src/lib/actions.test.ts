import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  toast: {
    loading: vi.fn(() => "toast-1"),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("./api", () => {
  class ApiError extends Error {
    constructor(
      message: string,
      readonly tag: string,
      readonly detail: string | undefined,
    ) {
      super(message);
    }
  }
  return { ApiError, api: vi.fn(), useEvent: () => {} };
});

const { refuseWhileBusy, runAction } = await import("./actions");
const { busyOf } = await import("@/stores/busy");
const { ApiError } = (await import("./api")) as unknown as {
  ApiError: new (message: string, tag: string, detail?: string) => Error;
};
const { keys, queryClient } = await import("./queries");

const repo = "local:/repo";

let invalidated: unknown[][];
beforeEach(() => {
  vi.clearAllMocks();
  invalidated = [];
  vi.spyOn(queryClient, "invalidateQueries").mockImplementation(async (f) => {
    invalidated.push([...(f?.queryKey ?? [])]);
  });
});

it("returns the result and refreshes the repository", async () => {
  await expect(runAction(repo, "Stage", async () => 42)).resolves.toBe(42);
  expect(mocks.toast.loading).not.toHaveBeenCalled();
  expect(mocks.toast.success).not.toHaveBeenCalled();
  expect(invalidated).toEqual([[...keys.info(repo)], [...keys.refs(repo)], [...keys.status(repo)]]);
});

it("shows progress, then success in the same toast", async () => {
  await runAction(repo, "Pull", async () => {}, { progress: "Pulling…", success: "Pulled" });
  expect(mocks.toast.loading).toHaveBeenCalledWith("Pulling…");
  expect(mocks.toast.success).toHaveBeenCalledWith("Pulled", { id: "toast-1" });
  expect(mocks.toast.dismiss).not.toHaveBeenCalled();
});

it("dismisses the progress toast when there is no success message", async () => {
  await runAction(repo, "Fetch", async () => {}, { progress: "Fetching…" });
  expect(mocks.toast.dismiss).toHaveBeenCalledWith("toast-1");
});

it("shows success without a progress toast", async () => {
  await runAction(repo, "Stash", async () => {}, { success: "Stashed" });
  expect(mocks.toast.success).toHaveBeenCalledWith("Stashed", { id: undefined });
});

it("reports failures as error toasts and still refreshes", async () => {
  const result = await runAction(
    repo,
    "Push",
    async () => {
      throw new ApiError("push rejected", "GitError", "! [rejected] main -> main");
    },
    { progress: "Pushing…" },
  );
  expect(result).toBeUndefined();
  expect(mocks.toast.error).toHaveBeenCalledWith("Push failed", {
    id: "toast-1",
    description: "push rejected\n\n! [rejected] main -> main",
    duration: 10000,
  });
  expect(invalidated).toHaveLength(3);
});

it("does not repeat a detail that equals the message", async () => {
  await runAction(repo, "Merge", async () => {
    throw new ApiError("conflict", "GitError", "conflict");
  });
  expect(mocks.toast.error).toHaveBeenCalledWith(
    "Merge failed",
    expect.objectContaining({ id: undefined, description: "conflict" }),
  );
});

it("describes non-Error failures", async () => {
  await runAction(repo, "Reset", () => Promise.reject("boom" as unknown as Error));
  expect(mocks.toast.error).toHaveBeenCalledWith(
    "Reset failed",
    expect.objectContaining({ description: "boom" }),
  );
  await runAction(repo, "Reset", async () => {
    throw new Error("plain");
  });
  expect(mocks.toast.error).toHaveBeenLastCalledWith(
    "Reset failed",
    expect.objectContaining({ description: "plain" }),
  );
});

it("runs one action at a time per repository, marking it busy", async () => {
  let release!: () => void;
  const fn = vi.fn(() => new Promise<string>((r) => (release = () => r("done"))));
  const first = runAction(repo, "Checkout", fn, { status: "Checking out feature…" });
  expect(busyOf(repo)).toEqual({ label: "Checking out feature…", cancellable: false });

  // Any other action in the same repository is refused, with a reason.
  const other = vi.fn(async () => "pulled");
  await expect(runAction(repo, "Pull", other)).resolves.toBeUndefined();
  expect(other).not.toHaveBeenCalled();
  expect(mocks.toast.warning).toHaveBeenCalledWith("Cannot pull now", {
    description: "Checking out feature… Wait for it to finish.",
  });
  expect(refuseWhileBusy(repo, "Merge")).toBe(true);
  // Other repositories are independent.
  await expect(runAction("local:/other", "Fetch", async () => "x")).resolves.toBe("x");

  release();
  await expect(first).resolves.toBe("done");
  expect(fn).toHaveBeenCalledTimes(1);
  expect(busyOf(repo)).toBeNull();
  expect(refuseWhileBusy(repo, "Merge")).toBe(false);
  // Once finished, the next one runs.
  await expect(runAction(repo, "Pull", other)).resolves.toBe("pulled");
});

it("labels the busy state from the progress message or the label", async () => {
  let release!: () => void;
  const wait = () => new Promise<void>((r) => (release = r));
  const pull = runAction(repo, "Pull", wait, { progress: "Pulling…", cancellable: true });
  expect(busyOf(repo)).toEqual({ label: "Pulling…", cancellable: true });
  release();
  await pull;
  const stage = runAction(repo, "Stage", wait);
  expect(busyOf(repo)?.label).toBe("Stage…");
  release();
  await stage;
});

it("reports a cancelled action without an error", async () => {
  await runAction(
    repo,
    "Fetch",
    async () => {
      throw new ApiError("Operation was cancelled", "CancelledError");
    },
    { progress: "Fetching…", cancellable: true },
  );
  expect(mocks.toast.info).toHaveBeenCalledWith("Fetch cancelled", { id: "toast-1" });
  expect(mocks.toast.error).not.toHaveBeenCalled();
  expect(busyOf(repo)).toBeNull();
});
