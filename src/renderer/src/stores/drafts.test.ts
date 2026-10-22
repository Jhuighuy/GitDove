// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { EMPTY_DRAFT, useDrafts } from "./drafts";

const A = "local:/a";
const B = "local:/b";

const saved = () => JSON.parse(localStorage.getItem("gitdove.drafts") ?? "null")?.state?.drafts;

beforeEach(() => {
  localStorage.clear();
  useDrafts.setState({ drafts: {} });
});

it("saves typed messages, without amending", () => {
  useDrafts.getState().set(A, { summary: "Fix", description: "Details", amend: true });
  expect(saved()).toEqual({ [A]: { summary: "Fix", description: "Details" } });
});

it("does not save the previous commit's message prefilled for amending", () => {
  useDrafts.getState().set(A, { summary: "Old", description: "Body", amend: true });
  useDrafts.getState().set(A, { prefill: "Old\n\nBody" });
  useDrafts.getState().set(B, { summary: "Typed" });
  expect(saved()).toEqual({ [B]: { summary: "Typed", description: "" } });
  // Once edited, it is the user's message.
  useDrafts.getState().set(A, { summary: "Old, reworded" });
  expect(saved()[A]).toEqual({ summary: "Old, reworded", description: "Body" });
});

it("drops the prefilled message, but not an edited one, when amending stops", () => {
  useDrafts.getState().set(A, { summary: "Old", amend: true, prefill: "Old" });
  useDrafts.getState().set(B, { summary: "Old, reworded", amend: true, prefill: "Old" });
  useDrafts.getState().stopAmending(A);
  useDrafts.getState().stopAmending(B);
  expect(useDrafts.getState().drafts[A]).toBeUndefined();
  expect(useDrafts.getState().drafts[B]).toEqual({
    ...EMPTY_DRAFT,
    summary: "Old, reworded",
  });
});
