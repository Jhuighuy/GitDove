// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type SectionDef, SectionStack, useSectionStack } from "./SectionStack";

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useSectionStack.setState({ open: {}, weights: {}, hidden: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const section = (id: string, extra: Partial<SectionDef> = {}): SectionDef => ({
  id,
  title: id.toUpperCase(),
  icon: null,
  count: <span>{id.length}</span>,
  children: <div data-testid={`${id}-body`}>{id} body</div>,
  ...extra,
});

const render = (sections: SectionDef[]) =>
  act(() => root.render(<SectionStack sections={sections} />));
const header = (title: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.startsWith(title))!;
const body = (id: string) => container.querySelector(`[data-testid=${id}-body]`);
const sectionEl = (id: string) => body(id)?.closest<HTMLElement>(".relative") ?? null;
const separators = () => [...container.querySelectorAll<HTMLElement>("[role=separator]")];

it("expands and collapses sections, remembering the choice", () => {
  render([section("a"), section("b", { defaultOpen: false })]);
  expect(header("A").textContent).toBe("A1");
  expect(body("a")).not.toBeNull();
  expect(body("b")).toBeNull();
  // Only expanded sections share space and can be resized against each other.
  expect(separators()).toHaveLength(0);

  act(() => header("B").click());
  expect(body("b")).not.toBeNull();
  expect(separators()).toHaveLength(1);
  act(() => header("A").click());
  expect(body("a")).toBeNull();
  expect(useSectionStack.getState().open).toEqual({ a: false, b: true });
  // A collapsed section takes no extra space.
  const a = header("A").parentElement!;
  expect(["none", "0 0 auto"]).toContain(a.style.flex);
});

it("leaves out hidden sections", () => {
  useSectionStack.setState({ hidden: { b: true } });
  render([section("a"), section("b"), section("c")]);
  expect(body("b")).toBeNull();
  expect(header("B")).toBeUndefined();
  // The remaining sections still resize against each other.
  expect(separators()).toHaveLength(1);
  act(() => useSectionStack.getState().setHidden("b", false));
  expect(body("b")).not.toBeNull();
  expect(useSectionStack.getState().hidden).toEqual({});
});

it("shows every section rather than none", () => {
  // E.g. all but Submodules hidden, in a repository without submodules.
  useSectionStack.setState({ hidden: { a: true, b: true, sub: true } });
  render([section("a"), section("b")]);
  expect(body("a")).not.toBeNull();
  expect(body("b")).not.toBeNull();
});

it("forwards header context menus", () => {
  const onHeaderContextMenu = vi.fn();
  render([section("a", { onHeaderContextMenu })]);
  act(() => header("A").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
  expect(onHeaderContextMenu).toHaveBeenCalledOnce();
});

it("resizes neighbouring sections by dragging the boundary", () => {
  // Every section is 128px tall, i.e. 100px of body under a 28px header.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    height: 128,
  } as DOMRect);
  render([section("a"), section("b", { defaultOpen: false }), section("c"), section("d")]);
  // The boundary above `c` resizes it against `a`, skipping the collapsed `b`.
  const [aboveC, aboveD] = separators();
  expect(sectionEl("c")!.contains(aboveC!)).toBe(true);
  const target = aboveC!;
  target.setPointerCapture = () => {};
  const fire = (type: string, y: number) =>
    act(() =>
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientY: y, pointerId: 1 })),
    );
  const flex = (id: string) => sectionEl(id)!.style.flex;
  fire("pointerdown", 200);
  fire("pointermove", 230);
  expect(flex("a")).toBe("130 1 0px");
  expect(flex("c")).toBe("70 1 0px");
  // The boundary reports where it is.
  expect(target.getAttribute("aria-valuenow")).toBe("65");
  // Saved once the drag ends.
  expect(useSectionStack.getState().weights).toEqual({});
  // Sections keep a minimum height.
  fire("pointermove", 1000);
  expect([flex("a"), flex("c")]).toEqual(["156 1 0px", "44 1 0px"]);
  fire("pointermove", -1000);
  expect([flex("a"), flex("c")]).toEqual(["44 1 0px", "156 1 0px"]);
  fire("pointerup", 0);
  expect(useSectionStack.getState().weights).toEqual({ a: 44, c: 156, d: 100 });
  fire("pointermove", 230);
  expect(useSectionStack.getState().weights).toMatchObject({ a: 44, c: 156 });
  expect(aboveD).toBeDefined();
});

it("ends a cancelled drag and moves boundaries with the arrow keys", () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    height: 128,
  } as DOMRect);
  render([section("a"), section("b")]);
  const [target] = separators();
  target!.setPointerCapture = () => {};
  const fire = (type: string, y: number) =>
    act(() =>
      target!.dispatchEvent(new PointerEvent(type, { bubbles: true, clientY: y, pointerId: 1 })),
    );
  fire("pointerdown", 200);
  fire("pointermove", 210);
  fire("pointercancel", 210);
  fire("pointermove", 260);
  expect(useSectionStack.getState().weights).toEqual({ a: 110, b: 90 });

  act(() =>
    target!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
  );
  expect(useSectionStack.getState().weights).toEqual({ a: 124, b: 76 });
  expect(target!.getAttribute("aria-label")).toBe("Resize B");
});

it("tells assistive technology whether a section is expanded", () => {
  render([section("a"), section("b", { defaultOpen: false })]);
  expect(header("A").getAttribute("aria-expanded")).toBe("true");
  expect(document.getElementById(header("A").getAttribute("aria-controls")!)).toBe(
    body("a")!.parentElement,
  );
  expect(header("B").getAttribute("aria-expanded")).toBe("false");
});
