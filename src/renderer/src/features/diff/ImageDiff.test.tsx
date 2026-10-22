// @vitest-environment happy-dom
import type { FileContent, FileVersions } from "@shared/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffMode } from "@/stores/repo-ui";
import { fitScale, ImageDiff } from "./ImageDiff";

const mocks = vi.hoisted(() => ({
  versions: null as FileVersions | Error | null,
  /** Natural sizes by blob contents; contents not listed fail to decode. */
  sizes: {} as Record<string, [number, number]>,
  revoked: [] as string[],
}));

vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  api: async () => {
    if (mocks.versions instanceof Error) throw mocks.versions;
    return mocks.versions ?? new Promise(() => {});
  },
}));

const blobs = new Map<string, Promise<string>>();
let nextUrl = 0;

class FakeImage extends EventTarget {
  naturalWidth = 0;
  naturalHeight = 0;
  set src(url: string) {
    void blobs.get(url)!.then((contents) => {
      const size = mocks.sizes[contents];
      if (size) [this.naturalWidth, this.naturalHeight] = size;
      this.dispatchEvent(new Event(size ? "load" : "error"));
    });
  }
}

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

const blob = (s: string): FileContent => ({ kind: "blob", bytes: new TextEncoder().encode(s) });
const MISSING: FileContent = { kind: "missing" };

let root: Root | null = null;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.versions = null;
  mocks.sizes = { a: [200, 100], b: [100, 100], v: [24, 24] };
  mocks.revoked = [];
  blobs.clear();
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.spyOn(URL, "createObjectURL").mockImplementation((b) => {
    const url = `blob:${nextUrl++}`;
    blobs.set(url, (b as Blob).text());
    return url;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => void mocks.revoked.push(url));
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(224);
  container = document.createElement("div");
});

const unmount = () => {
  act(() => root?.unmount());
  root = null;
};

afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Mounts afresh, so that each render fetches the current `mocks.versions`. */
async function render(mode: DiffMode = "split", mime = "image/png") {
  unmount();
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <ImageDiff
          repo="local:/repo"
          target={{ kind: "commit", hash: "abc", path: "x.png" }}
          mime={mime}
          mode={mode}
        />
      </QueryClientProvider>,
    ),
  );
  // Let blobs be read and images decode.
  for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}

const images = () =>
  [...container.querySelectorAll("img")].map((img) => [img.alt, img.style.width, img.style.height]);
const footer = () => container.lastElementChild?.lastElementChild?.textContent;

describe("ImageDiff", () => {
  it("shows a spinner while loading and errors when the fetch fails", async () => {
    await render();
    expect(container.querySelector("[role=status], svg")).not.toBeNull();
    mocks.versions = new Error("boom");
    await render();
    expect(container.textContent).toContain("boom");
  });

  it("shows both sides at one scale, side by side", async () => {
    mocks.versions = { old: blob("a"), new: blob("b") };
    await render("split");
    // Two columns of (400 - 16) / 2 = 192px; the wider image sets the scale.
    expect(images()).toEqual([
      ["Before", "192px", "96px"],
      ["After", "96px", "96px"],
    ]);
    expect(footer()).toBe("Before 200×100 · 1 BAfter 100×100 · 1 B");
  });

  it("overlays both sides in swipe mode", async () => {
    mocks.versions = { old: blob("a"), new: blob("b") };
    await render("unified");
    expect(images()).toEqual([
      ["Before", "200px", "100px"],
      ["After", "100px", "100px"],
    ]);
    const slider = container.querySelector<HTMLInputElement>("input[type=range]")!;
    expect(slider.value).toBe("50");
    const clip = (alt: string) =>
      (container.querySelector(`img[alt=${alt}]`)!.parentElement as HTMLElement).style.clipPath;
    expect([clip("Before"), clip("After")]).toEqual(["inset(0 50% 0 0)", "inset(0 0 0 50%)"]);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, "25");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect([clip("Before"), clip("After")]).toEqual(["inset(0 75% 0 0)", "inset(0 0 0 25%)"]);
  });

  it("falls back to side by side when a side cannot be shown", async () => {
    mocks.versions = { old: blob("broken"), new: { kind: "large", size: 30 * 1024 * 1024 } };
    await render("unified");
    expect(container.querySelector("input[type=range]")).toBeNull();
    expect(container.textContent).toContain("Cannot display this image.");
    expect(container.textContent).toContain("Too large to display (30 MB).");
  });

  it("recognizes Git LFS pointers", async () => {
    const pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12\n";
    mocks.versions = { old: blob(pointer), new: blob("a") };
    await render("split");
    expect(container.textContent).toContain("Stored in Git LFS: only its pointer is here.");
  });

  it("labels added and deleted images", async () => {
    mocks.versions = { old: MISSING, new: blob("b") };
    await render();
    expect(images().map(([alt]) => alt)).toEqual(["Added"]);
    mocks.versions = { old: blob("a"), new: MISSING };
    await render();
    expect(footer()).toBe("Deleted 200×100 · 1 B");
    mocks.versions = { old: MISSING, new: MISSING };
    await render();
    expect(container.textContent).toContain("No content.");
  });

  it("scales vector images up to fill the space", async () => {
    mocks.versions = { old: MISSING, new: blob("v") };
    await render("split", "image/svg+xml");
    // min(400 / 24, 200 / 24): the height, less the caption, limits it.
    expect(images()).toEqual([["Added", "200px", "200px"]]);
  });

  it("releases object URLs", async () => {
    mocks.versions = { old: blob("a"), new: blob("b") };
    await render();
    unmount();
    expect(mocks.revoked.length).toBeGreaterThanOrEqual(2);
  });
});

describe("fitScale", () => {
  it("fits without upscaling raster images", () => {
    expect(fitScale(200, 100, 100, 100, false)).toBe(0.5);
    expect(fitScale(10, 10, 100, 100, false)).toBe(1);
    expect(fitScale(10, 10, 100, 50, true)).toBe(5);
    expect(fitScale(0, 0, 100, 100, true)).toBe(1);
    expect(fitScale(10, 10, -5, 100, false)).toBe(0);
  });
});
