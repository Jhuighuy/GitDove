import { expect, it } from "vitest";
import { languageFor } from "./highlight-protocol";

const available = [
  "ts",
  "js",
  "cpp",
  "py",
  "rust",
  "docker",
  "make",
  "cmake",
  "json",
  "xml",
  "bash",
  "ini",
  "yaml",
];

it("uses the extension when shiki knows it", () => {
  expect(languageFor("src/a.ts", available)).toBe("ts");
  expect(languageFor("A.PY", available)).toBe("py");
  expect(languageFor("dir.d/b.json", available)).toBe("json");
});

it("maps extensions to their shiki language", () => {
  expect(languageFor("include/a.hpp", available)).toBe("cpp");
  expect(languageFor("lib.rs", available)).toBe("rust");
  expect(languageFor("x.mjs", available)).toBe("js");
  expect(languageFor("icon.svg", available)).toBe("xml");
  expect(languageFor("ci.yml", available)).toBe("yaml");
  expect(languageFor("package-lock.lock", available)).toBe("json");
});

it("recognizes well-known file names", () => {
  expect(languageFor("docker/Dockerfile", available)).toBe("docker");
  expect(languageFor("GNUmakefile", available)).toBe("make");
  expect(languageFor("CMakeLists.txt", available)).toBe("cmake");
  expect(languageFor("home/.bashrc", available)).toBe("bash");
  expect(languageFor(".editorconfig", available)).toBe("ini");
});

it("leaves plain text and unknown files unhighlighted", () => {
  expect(languageFor("notes.txt", available)).toBeNull();
  expect(languageFor("a.unknown", available)).toBeNull();
  expect(languageFor("LICENSE", available)).toBeNull();
  // A dotfile has no extension.
  expect(languageFor(".ts", available)).toBeNull();
  // A mapped language that is not available.
  expect(languageFor("a.kt", available)).toBeNull();
});
