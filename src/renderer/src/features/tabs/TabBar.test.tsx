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

it("opens new tabs from the button", async () => {
  await act(async () => container.querySelector<HTMLElement>('[aria-label="New tab"]')!.click());
  // The existing blank tab is reused.
  expect(useTabs.getState().active).toBe("c");
  expect(keys()).toHaveLength(3);

  useTabs.setState({ tabs: [{ key: "a", repo: "local:/x" }], active: "a" });
  await act(async () => container.querySelector<HTMLElement>('[aria-label="New tab"]')!.click());
  expect(keys()).toHaveLength(2);
  expect(tabs()[1]!.getAttribute("aria-selected")).toBe("true");
});

it("moves between tabs and closes them from the keyboard", async () => {
  const press = (el: HTMLElement, key: string) =>
    act(async () => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  expect(container.querySelector('[role="tablist"]')?.contains(tabs()[0]!)).toBe(true);
  // Only the active tab is in the tab order.
  expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1]);
  await press(tabs()[0]!, "ArrowRight");
  expect(useTabs.getState().active).toBe("b");
  expect(document.activeElement).toBe(tabs()[1]);
  await press(tabs()[1]!, "End");
  expect(useTabs.getState().active).toBe("c");
  await press(tabs()[2]!, "ArrowRight");
  expect(useTabs.getState().active).toBe("a");
  await press(tabs()[0]!, "Delete");
  expect(keys()).toEqual(["b", "c"]);
});
