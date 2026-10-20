// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ api: vi.fn(), prompt: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: mocks.api,
  ApiError: Error,
  useEvent: () => {},
  isMac: true,
  modKey: "⌘",
  platform: "darwin",
}));
vi.mock("./dialogs/dialogs", () => ({
  prompt: mocks.prompt,
  confirm: vi.fn(),
  validateRefName: () => null,
}));
vi.mock("./open/OpenRepo", () => ({ openLocation: vi.fn() }));

const { commands } = await import("./commands");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.api.mockResolvedValue(undefined);
});

it("creates an annotated tag when a message is given", async () => {
  mocks.prompt.mockResolvedValue({ value: "v1.0.0", checked: false, details: "Release notes" });
  await commands.createTag("local:/repo", "abc123");
  expect(mocks.prompt).toHaveBeenCalledWith(
    expect.objectContaining({ details: expect.objectContaining({ label: "Message (optional)" }) }),
  );
  expect(mocks.api).toHaveBeenCalledWith(
    "repo.createTag",
    "local:/repo",
    "v1.0.0",
    "abc123",
    "Release notes",
  );
});

it("creates a lightweight tag without a message", async () => {
  mocks.prompt.mockResolvedValue({ value: "v1.0.0", checked: false, details: "" });
  await commands.createTag("local:/repo", "abc123");
  expect(mocks.api).toHaveBeenCalledWith("repo.createTag", "local:/repo", "v1.0.0", "abc123", null);
});

it("does nothing when the dialog is cancelled", async () => {
  mocks.prompt.mockResolvedValue(null);
  await commands.createTag("local:/repo", "abc123");
  expect(mocks.api).not.toHaveBeenCalledWith("repo.createTag", expect.anything());
  expect(mocks.api.mock.calls.filter(([m]) => m === "repo.createTag")).toHaveLength(0);
});
