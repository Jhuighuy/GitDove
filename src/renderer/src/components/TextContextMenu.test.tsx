// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TextContextMenu } from "./TextContextMenu";

const mocks = vi.hoisted(() => ({ calls: [] as unknown[][] }));

vi.mock("@/lib/api", () => ({
  api: async (...args: unknown[]) => void mocks.calls.push(args),
  isMac: true,
  modKey: "⌘",
}));

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.calls = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));

async function rightClick(el: Element) {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  await act(async () => el.dispatchEvent(event));
  await settle();
  return event;
}

const items = () =>
  [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].map((el) => ({
    label: el.firstChild?.textContent,
    disabled: el.hasAttribute("data-disabled"),
  }));

it("offers editing commands in a text field, and runs them on it", async () => {
  await act(async () =>
    root.render(
      <>
        <input defaultValue="hello world" />
        <TextContextMenu />
      </>,
    ),
  );
  const input = container.querySelector("input")!;
  input.setSelectionRange(0, 5);
  const event = await rightClick(input);
  expect(event.defaultPrevented).toBe(true);
  expect(items()).toEqual([
    { label: "Undo", disabled: false },
    { label: "Redo", disabled: false },
    { label: "Cut", disabled: false },
    { label: "Copy", disabled: false },
    { label: "Paste", disabled: false },
    { label: "Select All", disabled: false },
  ]);
  expect(document.body.textContent).toContain("⇧⌘Z");

  const cut = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")][2]!;
  await act(async () => cut.click());
  await settle();
  expect(mocks.calls).toEqual([["app.edit", "cut"]]);
  // The field has its focus and selection back for the command.
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 5]);
});

it("disables cut and copy without a selection, and editing in read-only fields", async () => {
  await act(async () =>
    root.render(
      <>
        <textarea defaultValue="text" />
        <input readOnly defaultValue="fixed" />
        <TextContextMenu />
      </>,
    ),
  );
  const area = container.querySelector("textarea")!;
  area.setSelectionRange(2, 2);
  await rightClick(area);
  expect(
    items()
      .filter((i) => i.disabled)
      .map((i) => i.label),
  ).toEqual(["Cut", "Copy"]);

  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  await settle();
  const input = container.querySelector("input")!;
  input.setSelectionRange(0, 2);
  await rightClick(input);
  expect(items().map((i) => i.label)).toEqual(["Copy", "Select All"]);
});

it("offers copy for selected text, and nothing without it or over another menu", async () => {
  await act(async () =>
    root.render(
      <>
        <p>some text</p>
        <div onContextMenu={(e) => e.preventDefault()}>own menu</div>
        <TextContextMenu />
      </>,
    ),
  );
  const p = container.querySelector("p")!;
  expect((await rightClick(p)).defaultPrevented).toBe(false);
  expect(items()).toEqual([]);

  const range = document.createRange();
  range.selectNodeContents(p);
  window.getSelection()!.addRange(range);
  expect((await rightClick(container.querySelector("div")!)).defaultPrevented).toBe(true);
  expect(items()).toEqual([]);

  await rightClick(p);
  expect(items()).toEqual([{ label: "Copy", disabled: false }]);
});
