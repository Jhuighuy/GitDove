// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { confirm, DialogHost, prompt, validateRefName } from "./dialogs";

let root: Root;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<DialogHost />));
});

// Unmount, so a previous test's host can't render dialogs alongside the next one.
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

/** Sets a controlled input's value the way typing does. */
const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};

const byId = <T extends HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is not rendered`);
  return el as T;
};

const button = (label: string) => {
  const el = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (!el) throw new Error(`No "${label}" button`);
  return el;
};

it("returns the optional multi-line details, trimmed", async () => {
  let result: Awaited<ReturnType<typeof prompt>> | undefined;
  await act(async () => {
    void prompt({
      title: "Create tag",
      label: "Tag name",
      confirmLabel: "Create Tag",
      details: { label: "Message (optional)" },
    }).then((r) => (result = r));
  });
  expect(document.body.textContent).toContain("Message (optional)");
  expect(document.querySelectorAll("#prompt-input")).toHaveLength(1);

  await act(async () => {
    type(byId<HTMLInputElement>("prompt-input"), "v1.0.0");
    type(byId<HTMLTextAreaElement>("prompt-details"), "  Release 1.0\n\nNotes.  ");
  });
  // Plain Enter adds a line; Cmd/Ctrl+Enter submits.
  await act(async () => {
    byId("prompt-details").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
  expect(result).toBeUndefined();
  // Nor does Cmd+Enter while an input method is still composing.
  await act(async () => {
    byId("prompt-details").dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: true,
        isComposing: true,
        bubbles: true,
      }),
    );
  });
  expect(result).toBeUndefined();
  await act(async () => {
    byId("prompt-details").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }),
    );
  });
  expect(result).toEqual({ value: "v1.0.0", checked: false, details: "Release 1.0\n\nNotes." });
});

it("returns empty details when the field is unused", async () => {
  let result: Awaited<ReturnType<typeof prompt>> | undefined;
  await act(async () => {
    void prompt({ title: "Rename", confirmLabel: "Rename" }).then((r) => (result = r));
  });
  expect(document.getElementById("prompt-details")).toBeNull();
  await act(async () => type(byId<HTMLInputElement>("prompt-input"), "topic"));
  await act(async () => button("Rename").click());
  expect(result).toEqual({ value: "topic", checked: false, details: "" });
});

it("starts each prompt from its own default, also right after another one", async () => {
  let first: Awaited<ReturnType<typeof prompt>> | undefined;
  await act(async () => {
    // Like `commands.addRemote`: the next prompt opens as soon as the first one is answered.
    void prompt({ title: "Add remote", confirmLabel: "Next", defaultValue: "origin" }).then((r) => {
      first = r;
      void prompt({ title: "Add remote upstream", label: "URL", confirmLabel: "Add Remote" });
    });
  });
  await act(async () => type(byId<HTMLInputElement>("prompt-input"), "upstream"));
  await act(async () => button("Next").click());
  expect(first).toMatchObject({ value: "upstream" });
  expect(document.body.textContent).toContain("Add remote upstream");
  // It opens in the same place, but must not show "upstream".
  expect(byId<HTMLInputElement>("prompt-input").value).toBe("");
});

it("focuses Cancel in destructive confirmations", async () => {
  await act(async () => {
    void confirm({ title: "Delete topic?", confirmLabel: "Delete", destructive: true });
  });
  expect(document.activeElement?.textContent).toBe("Cancel");
  await act(async () => {
    void confirm({ title: "Merge topic?", confirmLabel: "Merge" });
  });
  expect(document.activeElement?.textContent).toBe("Merge");
});

it("validates branch and tag names like git", () => {
  for (const ok of ["main", "feature/x", "v1.0.0", "a.b/c-d_e", "user@host"]) {
    expect(validateRefName(ok)).toBeNull();
  }
  for (const bad of [
    "a b",
    "a..b",
    "a~1",
    "a^",
    "a:b",
    "a?",
    "a*",
    "a[b",
    "a\\b",
    "a@{1}",
    "@",
    "-x",
    "/x",
    "x/",
    "x.",
    "x.lock",
    "a//b",
    ".hidden",
    "a/.b",
    "foo.lock/bar",
    "a\u0001b",
    "a\u007fb",
  ]) {
    expect(validateRefName(bad), bad).not.toBeNull();
  }
});
