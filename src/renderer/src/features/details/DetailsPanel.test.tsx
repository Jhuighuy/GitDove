// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useRepoUiStore } from "@/stores/repo-ui";
import { DetailsPanel } from "./DetailsPanel";

vi.mock("./CommitPanel", () => ({
  CommitPanel: ({ repo, hash }: { repo: string; hash: string }) => `commit ${repo} ${hash}`,
}));
vi.mock("./CommitsPanel", () => ({
  CommitsPanel: ({ commits }: { commits: { row: { hash: string } }[] }) =>
    `commits ${commits.map((c) => c.row.hash).join(" ")}`,
}));
vi.mock("./WipPanel", () => ({ WipPanel: ({ repo }: { repo: string }) => `wip ${repo}` }));

it("shows the selected commit, or the working tree otherwise", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const repo = "local:/repo";
  await act(async () => root.render(<DetailsPanel repo={repo} />));
  expect(container.textContent).toBe("wip local:/repo");
  await act(async () => useRepoUiStore.getState().select(repo, { kind: "commit", hash: "c1" }));
  expect(container.textContent).toBe("commit local:/repo c1");
  await act(async () => useRepoUiStore.getState().select(repo, { kind: "wip" }));
  expect(container.textContent).toBe("wip local:/repo");
  // Selections of other repositories do not matter.
  await act(async () =>
    useRepoUiStore.getState().select("local:/x", { kind: "commit", hash: "c" }),
  );
  expect(container.textContent).toBe("wip local:/repo");
  await act(async () => root.unmount());
});
