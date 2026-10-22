// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTabs } from "@/stores/tabs";
import { TabBar } from "./TabBar";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: mocks.api, isMac: true }));

let root: Root;
let container: HTMLElement;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.api.mockReset();
  mocks.api.mockResolvedValue(undefined);
  useTabs.setState({
    tabs: [
      { key: "a", repo: "local:/home/me/alpha" },
      { key: "b", repo: "ssh://box/srv/beta/" },
      { key: "c", repo: null },
    ],
    active: "a",
    recent: [],
    loaded: true,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<TabBar />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const tabs = () => [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
const keys = () => useTabs.getState().tabs.map((t) => t.key);
const mouse = (el: Element, type: string, button = 0) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, button }));
  });

it("shows a tab per repository", () => {
  expect(tabs().map((t) => [t.textContent, t.title, t.getAttribute("aria-selected")])).toEqual([
    ["alpha", "/home/me/alpha", "true"],
    ["beta", "box:/srv/beta/", "false"],
    ["New Tab", "New tab", "false"],
  ]);
  // Room for the traffic lights on macOS.
  expect(container.firstElementChild!.className).toContain("pl-20");
});

it("activates tabs with the left button and closes them with the middle one", async () => {
  await mouse(tabs()[1]!, "mousedown");
  expect(useTabs.getState().active).toBe("b");
  expect(tabs()[1]!.getAttribute("aria-selected")).toBe("true");
  await mouse(tabs()[0]!, "mousedown", 1);
  expect(keys()).toEqual(["b", "c"]);
  expect(mocks.api).toHaveBeenCalledWith("repo.close", "local:/home/me/alpha");
  // Other buttons do nothing.
  await mouse(tabs()[1]!, "mousedown", 2);
  expect(useTabs.getState().active).toBe("b");
});

it("closes tabs with their close button without activating them", async () => {
  const close = tabs()[1]!.querySelector<HTMLButtonElement>('[aria-label="Close tab"]')!;
  await mouse(close, "mousedown");
  expect(useTabs.getState().active).toBe("a");
  await act(async () => close.click());
  expect(keys()).toEqual(["a", "c"]);
  expect(tabs().map((t) => t.textContent)).toEqual(["alpha", "New Tab"]);
});

it("opens new tabs from the button and by double-clicking the empty bar", async () => {
  await act(async () => container.querySelector<HTMLElement>('[aria-label="New tab"]')!.click());
  // The existing blank tab is reused.
  expect(useTabs.getState().active).toBe("c");
  expect(keys()).toHaveLength(3);

  useTabs.setState({ tabs: [{ key: "a", repo: "local:/x" }], active: "a" });
  await mouse(tabs()[0]!, "dblclick");
  expect(keys()).toEqual(["a"]);
  await mouse(container.firstElementChild!, "dblclick");
  expect(keys()).toHaveLength(2);
  expect(tabs()[1]!.getAttribute("aria-selected")).toBe("true");
});

it("reorders tabs by dragging them", async () => {
  // Tabs are 100px wide, side by side.
  tabs().forEach((el, i) => {
    el.getBoundingClientRect = () => ({ left: i * 100, width: 100 }) as DOMRect;
  });
  const pointer = (target: EventTarget, type: string, clientX: number) =>
    act(async () => {
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, clientX }));
    });
  await pointer(tabs()[0]!, "pointerdown", 50);
  // A small wobble is still a click.
  await pointer(window, "pointermove", 52);
  expect(keys()).toEqual(["a", "b", "c"]);
  // Past the middle of "b".
  await pointer(window, "pointermove", 160);
  expect(keys()).toEqual(["b", "a", "c"]);
  await pointer(window, "pointermove", 260);
  expect(keys()).toEqual(["b", "c", "a"]);
  await pointer(window, "pointerup", 260);
  await pointer(window, "pointermove", 0);
  expect(keys()).toEqual(["b", "c", "a"]);
  // Leaving the window ends a drag too.
  await pointer(tabs()[0]!, "pointerdown", 50);
  await pointer(window, "pointermove", 160);
  expect(keys()).toEqual(["c", "b", "a"]);
  await act(async () => window.dispatchEvent(new Event("blur")));
  await pointer(window, "pointermove", 260);
  expect(keys()).toEqual(["c", "b", "a"]);
});
