// @vitest-environment happy-dom
import { DEFAULT_SETTINGS } from "@shared/settings";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/stores/settings";

const PICKED = "/Applications/Some Term.app";
const mocks = vi.hoisted(() => ({
  api: vi.fn(async (method: string, patch?: object): Promise<unknown> => {
    const { DEFAULT_SETTINGS: defaults } = await import("@shared/settings");
    const { useSettingsStore: store } = await import("@/stores/settings");
    if (method === "settings.terminals") {
      const picked = store.getState().settings.terminal !== "";
      return {
        defaultName: "Terminal",
        terminals: [
          { id: "terminal", name: "Terminal", installed: true },
          { id: "iterm", name: "iTerm", installed: false },
          { id: "ghostty", name: "Ghostty", installed: true },
        ],
        current: picked ? { name: "Some Term", remote: false } : { name: "Terminal", remote: true },
      };
    }
    if (method === "settings.pickTerminal") {
      return { ...defaults, terminal: "/Applications/Some Term.app" };
    }
    return { ...defaults, ...patch };
  }),
  listeners: new Map<string, (payload: unknown) => void>(),
}));
vi.mock("@/lib/api", () => ({
  api: mocks.api,
  useEvent: (event: string, listener: (payload: unknown) => void) =>
    mocks.listeners.set(event, listener),
  isMac: true,
  platform: "darwin",
}));

const { SettingsDialog, showSettings, useSettingsDialog } = await import("./SettingsDialog");

let root: Root;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.api.mockClear();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, loaded: true });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<SettingsDialog />));
});

afterEach(async () => {
  await act(async () => useSettingsDialog.setState({ open: false }));
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const button = (label: string) => {
  const el = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (!el) throw new Error(`No "${label}" button`);
  return el;
};

/** The control that the label `text` names. */
const control = (text: string): HTMLElement => {
  const label = [...document.querySelectorAll("label")].find((l) => l.textContent === text);
  if (!label) throw new Error(`No "${text}" setting`);
  return document.getElementById(label.htmlFor)!;
};

/** Sets a controlled input's value the way typing does. */
const type = (el: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};

const key = (el: HTMLElement, k: string) =>
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

it("opens from the menu, on the appearance settings", async () => {
  expect(document.body.textContent).not.toContain("Settings");
  await act(async () => mocks.listeners.get("menu.command")!({ command: "open-settings" }));
  expect(document.body.textContent).toContain("Theme");
  expect(document.body.textContent).toContain("Font ligatures");
  expect(control("Theme").textContent).toContain("Match System");
});

it("switches between sections", async () => {
  await act(async () => showSettings());
  await act(async () => button("Diffs").click());
  expect(control("Syntax theme (dark)").textContent).toContain("Vitesse Dark");
  expect(control("Tab width").textContent).toContain("4 spaces");
  await act(async () => button("Commits").click());
  expect(control("Dates").textContent).toContain("Relative");
  await act(async () => button("General").click());
  expect(document.body.textContent).toContain("Reopen tabs on launch");
});

it("offers the installed terminals, and others from a file dialog", async () => {
  await act(async () => showSettings());
  await act(async () => button("General").click());
  const terminal = control("Terminal");
  expect(terminal.textContent).toContain("Default (Terminal)");
  expect(document.body.textContent).toContain("remote ones over ssh");
  await act(async () => terminal.click());
  const options = () => [...document.querySelectorAll('[role="option"]')];
  expect(options().map((o) => o.textContent)).toEqual(["Default (Terminal)", "Ghostty", "Choose…"]);
  await act(async () => (options().at(-1) as HTMLElement).click());
  expect(mocks.api).toHaveBeenCalledWith("settings.pickTerminal");
  expect(useSettingsStore.getState().settings.terminal).toBe(PICKED);
  expect(mocks.api).not.toHaveBeenCalledWith("settings.set", expect.anything());
  expect(control("Terminal").textContent).toContain("Some Term");
  expect(document.body.textContent).toContain(
    "Some Term opens local repositories; remote ones open in Terminal.",
  );
});

it("changes a setting when a box is checked", async () => {
  await act(async () => showSettings());
  await act(async () => button("Commits").click());
  await act(async () => control("Author pictures").click());
  expect(mocks.api).toHaveBeenCalledWith("settings.set", { avatars: false });
  expect(useSettingsStore.getState().settings.avatars).toBe(false);
});

it("saves text on Enter, and puts it back on Escape", async () => {
  await act(async () => showSettings());
  const font = control("Code font") as HTMLInputElement;
  expect(font.placeholder).toBe("JetBrains Mono");
  await act(async () => type(font, "  Fira Code "));
  expect(mocks.api).not.toHaveBeenCalled();
  await act(async () => key(font, "Enter"));
  expect(mocks.api).toHaveBeenCalledWith("settings.set", { codeFont: "Fira Code" });
  expect(font.value).toBe("Fira Code");

  await act(async () => type(font, "Menlo"));
  await act(async () => key(font, "Escape"));
  expect(font.value).toBe("Fira Code");
  // Still open: Escape only cancelled the edit.
  expect(useSettingsDialog.getState().open).toBe(true);
  await act(async () => font.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(mocks.api).toHaveBeenCalledTimes(1);
});
