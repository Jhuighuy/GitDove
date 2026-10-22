// @vitest-environment happy-dom
import type { Ref } from "@shared/domain";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { groupRefs, RefPills } from "./RefPills";

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

const ref = (name: string, extra: Partial<Ref> = {}): Ref => {
  const remote = name.startsWith("refs/remotes/") ? name.split("/")[2]! : null;
  return {
    name,
    short: name.replace(/^refs\/(heads|remotes|tags)\//, ""),
    kind: remote ? "remote" : name.startsWith("refs/tags/") ? "tag" : "branch",
    hash: "h",
    upstream: null,
    ahead: 0,
    behind: 0,
    upstreamGone: false,
    isHead: false,
    remote,
    ...extra,
  };
};

it("merges local and remote branches of the same name, HEAD first", () => {
  const pills = groupRefs([
    ref("refs/tags/v1"),
    ref("refs/remotes/origin/feature"),
    ref("refs/remotes/origin/main"),
    ref("refs/remotes/upstream/main"),
    ref("refs/heads/feature"),
    ref("refs/heads/main", { isHead: true }),
    ref("refs/remotes/origin/other"),
  ]);
  expect(
    pills.map((p) => [
      p.label,
      p.local?.name ?? null,
      p.remotes.map((r) => r.short),
      p.tag?.short ?? null,
    ]),
  ).toEqual([
    ["main", "refs/heads/main", ["origin/main", "upstream/main"], null],
    ["feature", "refs/heads/feature", ["origin/feature"], null],
    ["origin/other", null, ["origin/other"], null],
    ["v1", null, [], "v1"],
  ]);
});

it("renders nothing without refs", () => {
  act(() => root.render(<RefPills refs={[]} color={0} />));
  expect(container.innerHTML).toBe("");
});

it("shows the first pill and counts the rest", () => {
  const onDoubleClick = vi.fn();
  const parent = vi.fn();
  const head = ref("refs/heads/main", { isHead: true });
  act(() =>
    root.render(
      <div onDoubleClick={parent}>
        <RefPills
          refs={[ref("refs/tags/v1"), ref("refs/remotes/origin/main"), head, ref("refs/heads/dev")]}
          color={1}
          onDoubleClick={onDoubleClick}
        />
      </div>,
    ),
  );
  const pill = container.querySelector<HTMLElement>("[title]")!;
  expect(pill.title).toBe("main, origin/main");
  expect(pill.textContent).toBe("main");
  expect(pill.className).toContain("font-semibold");
  // HEAD check, laptop (local) and cloud (remote) icons.
  expect(pill.querySelectorAll("svg")).toHaveLength(3);
  expect(container.textContent).toContain("+2");

  act(() => {
    pill.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  expect(onDoubleClick).toHaveBeenCalledWith(head);
  // The row below does not see the double click.
  expect(parent).not.toHaveBeenCalled();
});

it("shows a lone tag or remote pill with its icon", () => {
  act(() => root.render(<RefPills refs={[ref("refs/tags/v2")]} color={0} />));
  const pill = container.querySelector<HTMLElement>("[title]")!;
  expect(pill.title).toBe("v2");
  expect(pill.className).toContain("font-medium");
  expect(pill.querySelectorAll("svg")).toHaveLength(1);
  expect(container.textContent).not.toContain("+");
  // Without a handler a double click is harmless.
  act(() => {
    pill.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
});

it("expands the other pills in place, and checks them out on double click", async () => {
  const onDoubleClick = vi.fn();
  const dev = ref("refs/heads/dev");
  act(() =>
    root.render(
      <RefPills
        refs={[ref("refs/heads/main", { isHead: true }), dev, ref("refs/tags/v1")]}
        color={1}
        onDoubleClick={onDoubleClick}
      />,
    ),
  );
  const more = [...container.querySelectorAll("span")].find((s) => s.textContent === "+2")!;
  await act(async () => more.click());
  const popup = document.querySelector<HTMLElement>("[aria-label='Branches and tags']")!;
  // Many refs scroll inside the window instead of running off it.
  expect(popup.className).toContain("max-h-(--available-height)");
  expect(popup.className).toContain("overflow-y-auto");
  const pills = [...popup.querySelectorAll<HTMLElement>("[title]")];
  // All of them, the first one again on top.
  expect(pills.map((p) => p.textContent)).toEqual(["main", "dev", "v1"]);
  act(() => {
    pills[1]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  expect(onDoubleClick).toHaveBeenCalledWith(dev);
});

it("gives up its icons before its name in a narrow column", () => {
  act(() =>
    root.render(
      <RefPills
        refs={[ref("refs/heads/main", { isHead: true }), ref("refs/remotes/origin/main")]}
        color={0}
      />,
    ),
  );
  const pill = container.querySelector('[title="main, origin/main"]')!;
  const icons = [...pill.querySelectorAll("svg")].map((s) => s.getAttribute("class"));
  // The laptop and the cloud go first, then the check mark.
  expect(icons).toHaveLength(3);
  expect(icons[0]).toContain("@max-[80px]:hidden");
  expect(icons[1]).toContain("@max-[130px]:hidden");
  expect(icons[2]).toContain("@max-[130px]:hidden");
  expect(pill.querySelector("span")!.className).toContain("min-w-0 truncate");
});
