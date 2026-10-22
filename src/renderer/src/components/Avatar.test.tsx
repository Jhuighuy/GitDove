// @vitest-environment happy-dom
import type { AvatarProvider } from "@shared/avatars";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Avatar, MISSING_RETRY_MS, useAvatarProviders } from "./Avatar";

const mocks = vi.hoisted(() => ({ remotes: [] as { fetchUrl: string }[] }));

vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  api: async (method: string) => {
    if (method === "repo.refs") return { refs: [], stashes: [], remotes: mocks.remotes };
    throw new Error(`unexpected ${method}`);
  },
}));

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
  container.remove();
});

/** Reports the avatar providers of a repository. */
function Probe({
  repo,
  onValue,
}: {
  repo: string;
  onValue: (v: readonly AvatarProvider[]) => void;
}) {
  const value = useAvatarProviders(repo);
  // Report after commit: renders can be replayed or dropped.
  useEffect(() => {
    onValue(value);
  });
  return null;
}

const render = (el: React.ReactNode) => act(() => root.render(el));
const avatar = () => container.querySelector<HTMLElement>("span")!;
const img = () => container.querySelector("img");

it("shows initials until the picture has loaded", () => {
  render(<Avatar name="Ada Lovelace" email="Ada@Example.com" providers={["github"]} />);
  expect(avatar().textContent).toBe("AL");
  expect(avatar().title).toBe("Ada Lovelace <Ada@Example.com>");
  expect(avatar().style.width).toBe("18px");
  const image = img()!;
  expect(image.getAttribute("src")).toBe(
    "gitdove-avatar://avatar/?e=ada%40example.com&p=github&s=64",
  );
  expect(image.style.opacity).toBe("0");

  act(() => image.dispatchEvent(new Event("load")));
  expect(avatar().textContent).toBe("");
  expect(img()!.style.opacity).toBe("1");
});

it("requests larger pictures for large avatars", () => {
  render(<Avatar name="Ada" email="ada@example.com" providers={[]} size={32} />);
  expect(img()!.getAttribute("src")).toContain("&s=128");
  expect(avatar().textContent).toBe("AD");
});

it("shows only initials without an email address", () => {
  render(<Avatar name="" email="nobody" providers={[]} />);
  expect(img()).toBeNull();
  expect(avatar().textContent).toBe("?");
});

it("falls back to initials when the picture fails, and does not retry it", () => {
  render(<Avatar name="Bob Builder" email="bob@example.com" providers={[]} />);
  act(() => img()!.dispatchEvent(new Event("error")));
  expect(img()).toBeNull();
  expect(avatar().textContent).toBe("BB");
  // Another avatar for the same address (e.g. a recycled row) skips the picture.
  act(() => root.unmount());
  root = createRoot(container);
  render(<Avatar name="Bob Builder" email="bob@example.com" providers={[]} />);
  expect(img()).toBeNull();
});

it("retries a failed picture after a while", () => {
  vi.useFakeTimers();
  try {
    render(<Avatar name="Cy" email="cy@example.com" providers={[]} />);
    expect(img()!.getAttribute("loading")).toBe("lazy");
    act(() => img()!.dispatchEvent(new Event("error")));
    act(() => root.unmount());
    vi.advanceTimersByTime(MISSING_RETRY_MS);
    root = createRoot(container);
    render(<Avatar name="Cy" email="cy@example.com" providers={[]} />);
    expect(img()).not.toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("derives avatar providers from the remotes", async () => {
  mocks.remotes = [
    { fetchUrl: "git@github.com:a/b.git" },
    { fetchUrl: "https://gitlab.example.org/a/b.git" },
  ];
  const providers = { current: [] as readonly AvatarProvider[] };
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <Probe repo="local:/repo" onValue={(v) => (providers.current = v)} />
      </QueryClientProvider>,
    ),
  );
  await act(() => vi.waitFor(() => expect(providers.current).toHaveLength(2)));
  expect(providers.current).toEqual(["github", "gitlab:gitlab.example.org"]);
});

it("has no providers without remotes", async () => {
  mocks.remotes = [];
  const providers = { current: null as readonly AvatarProvider[] | null };
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <Probe repo="local:/other" onValue={(v) => (providers.current = v)} />
      </QueryClientProvider>,
    ),
  );
  expect(providers.current).toEqual([]);
});
