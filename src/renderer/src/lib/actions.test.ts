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
const { useStatusStore } = await import("@/stores/status");
const notice = () => useStatusStore.getState().notices[repo];
const { ApiError } = (await import("./api")) as unknown as {
  ApiError: new (message: string, tag: string, detail?: string) => Error;
};
const { keys, queryClient, WORKING_TREE } = await import("./queries");
const { useTabs } = await import("@/stores/tabs");

const repo = "local:/repo";

let invalidated: unknown[][];
/** Holds refreshes back until `refetched` is called. */
let hold: boolean;
let waiting: (() => void)[];
const refetched = () => waiting.splice(0).forEach((r) => r());
beforeEach(() => {
  vi.clearAllMocks();
  useStatusStore.setState({ notices: {}, activities: [] });
  useTabs.setState({ tabs: [{ key: "t", repo }], active: "t" });
  invalidated = [];
  hold = false;
  waiting = [];
  vi.spyOn(queryClient, "invalidateQueries").mockImplementation(async (f) => {
    invalidated.push([...(f?.queryKey ?? [])]);
    if (hold) await new Promise<void>((r) => waiting.push(r));
  });
});

const REPOSITORY_KEYS = [
  [...keys.info(repo)],
  [...keys.refs(repo)],
  [...keys.searches(repo)],
  [...keys.status(repo)],
  [...keys.diffs(repo)],
];

const run = runAction;

it("returns the result and refreshes the repository", async () => {
  await expect(run(repo, "Checkout", async () => 42)).resolves.toEqual({ ok: true, value: 42 });
  expect(notice()).toBeUndefined();
  expect(invalidated).toEqual(REPOSITORY_KEYS);
});

it("refreshes only what an action declares, and stays busy until that is on screen", async () => {
  hold = true;
  const result = runAction(repo, "Stage", async () => {}, { invalidates: WORKING_TREE });
  await vi.waitFor(() =>
    expect(invalidated).toEqual([[...keys.status(repo)], [...keys.diffs(repo)]]),
  );
  // Write controls stay disabled until fresh data is on screen.
  expect(busyOf(repo)).not.toBeNull();
  refetched();
  await expect(result).resolves.toEqual({ ok: true, value: undefined });
  expect(busyOf(repo)).toBeNull();
});

it("runs the optimistic update once the action may start", async () => {
  const order: string[] = [];
  await run(repo, "Stage", async () => void order.push("action"), {
    optimistic: () => void order.push("optimistic"),
  });
  expect(order).toEqual(["optimistic", "action"]);
});

it("reports success in the status bar, not in a toast", async () => {
  await run(repo, "Pull", async () => {}, { status: "Pulling…", success: "Pulled" });
  expect(notice()).toMatchObject({ text: "Pulled", kind: "success" });
  // Progress shows in the status bar too (see the busy state), never as a toast.
  for (const kind of ["loading", "success", "info", "dismiss"] as const) {
    expect(mocks.toast[kind]).not.toHaveBeenCalled();
  }
});

it("leaves no notice without a success message", async () => {
  await run(repo, "Fetch", async () => {}, { status: "Fetching…" });
  expect(notice()).toBeUndefined();
});

it("reports failures as error toasts and still refreshes", async () => {
  const result = await run(
    repo,
    "Push",
    async () => {
      throw new ApiError("push rejected", "GitError", "! [rejected] main -> main");
    },
    { status: "Pushing…" },
  );
  expect(result).toEqual({ ok: false });
  // Errors need attention: they stay toasts.
  expect(mocks.toast.error).toHaveBeenCalledWith("Push failed", {
    description: "push rejected\n\n! [rejected] main -> main",
    duration: 10000,
    action: { label: "Copy", onClick: expect.any(Function) },
  });
  expect(invalidated).toEqual(REPOSITORY_KEYS);
});

it("names the repository of a failure in a background tab", async () => {
  useTabs.setState({ tabs: [{ key: "t", repo: "local:/other" }], active: "t" });
  await run(repo, "Fetch", () => Promise.reject(new Error("offline")));
  expect(mocks.toast.error).toHaveBeenCalledWith("Fetch failed in repo", expect.anything());
});

it("does not repeat a detail that equals the message", async () => {
  await run(repo, "Merge", async () => {
    throw new ApiError("conflict", "GitError", "conflict");
  });
  expect(mocks.toast.error).toHaveBeenCalledWith(
    "Merge failed",
    expect.objectContaining({ description: "conflict" }),
  );
});

it("describes non-Error failures", async () => {
  await run(repo, "Reset", () => Promise.reject("boom" as unknown as Error));
  expect(mocks.toast.error).toHaveBeenCalledWith(
    "Reset failed",
    expect.objectContaining({ description: "boom" }),
  );
  invalidated = [];
  await run(repo, "Reset", async () => {
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
  expect(busyOf(repo)).toMatchObject({ label: "Checking out feature…", cancellable: false });

  // Any other action in the same repository is refused, with a reason.
  const other = vi.fn(async () => "pulled");
  await expect(runAction(repo, "Pull", other)).resolves.toEqual({ ok: false });
  expect(other).not.toHaveBeenCalled();
  expect(mocks.toast.warning).toHaveBeenCalledWith("Cannot pull now", {
    description: "Checking out feature… Wait for it to finish.",
  });
  expect(refuseWhileBusy(repo, "Merge")).toBe(true);
  // Other repositories are independent.
  await expect(runAction("local:/other", "Fetch", async () => "x")).resolves.toEqual({
    ok: true,
    value: "x",
  });

  release();
  await expect(first).resolves.toEqual({ ok: true, value: "done" });
  expect(fn).toHaveBeenCalledTimes(1);
  expect(busyOf(repo)).toBeNull();
  expect(refuseWhileBusy(repo, "Merge")).toBe(false);
  // Once finished, the next one runs.
  await expect(runAction(repo, "Pull", other)).resolves.toEqual({ ok: true, value: "pulled" });
});

it("labels the busy state from the status message or the label", async () => {
  let release!: () => void;
  const wait = () => new Promise<void>((r) => (release = r));
  const pull = runAction(repo, "Pull", wait, { status: "Pulling…", cancellable: true });
  expect(busyOf(repo)).toMatchObject({ label: "Pulling…", cancellable: true });
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
    { status: "Fetching…", cancellable: true },
  );
  expect(notice()).toMatchObject({ text: "Fetch cancelled", kind: "info" });
  expect(mocks.toast.error).not.toHaveBeenCalled();
  expect(mocks.toast.info).not.toHaveBeenCalled();
  expect(busyOf(repo)).toBeNull();
});

it("holds change events back while an action runs, and refreshes them once after it", async () => {
  const { takeHeldChanges } = await import("./queries");
  let release!: () => void;
  const action = runAction(repo, "Rebase", () => new Promise<void>((r) => (release = r)), {
    invalidates: ["refs"],
  });
  // What `useRepoEvents` does with a change event while the repository is busy.
  expect(busyOf(repo)).not.toBeNull();
  expect(takeHeldChanges(repo).size).toBe(0);
  release();
  await action;
  expect(invalidated).toEqual([[...keys.refs(repo)]]);
});

it("stops being busy even when the refresh after an action hangs", async () => {
  vi.useFakeTimers();
  try {
    hold = true;
    const action = runAction(repo, "Stage", async () => {}, { invalidates: ["status"] });
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(action).resolves.toEqual({ ok: true, value: undefined });
    expect(busyOf(repo)).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
