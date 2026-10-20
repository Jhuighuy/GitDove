// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type SectionDef, SectionStack, useSectionStack } from "./SectionStack";

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useSectionStack.setState({ open: {}, weights: {} });
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
  fire("pointerdown", 200);
  fire("pointermove", 230);
  expect(useSectionStack.getState().weights).toEqual({ a: 130, c: 70, d: 100 });
  expect(sectionEl("a")!.style.flex).toBe("130 1 0px");
  // Sections keep a minimum height.
  fire("pointermove", 1000);
  expect(useSectionStack.getState().weights).toMatchObject({ a: 156, c: 44 });
  fire("pointermove", -1000);
  expect(useSectionStack.getState().weights).toMatchObject({ a: 44, c: 156 });
  fire("pointerup", 0);
  fire("pointermove", 230);
  expect(useSectionStack.getState().weights).toMatchObject({ a: 44, c: 156 });
  expect(aboveD).toBeDefined();
});
