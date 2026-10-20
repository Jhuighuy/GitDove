/** Messages between the diff view and the highlighting worker. */

export type ThemeKind = "light" | "dark";

/** Lines per highlighting chunk. */
export const CHUNK = 200;

export type HighlightRequest =
  | {
      readonly type: "open";
      readonly doc: number;
      readonly path: string;
      readonly sides: readonly [string[], string[]];
      readonly resets: readonly [number[], number[]];
    }
  | {
      readonly type: "highlight";
      readonly doc: number;
      readonly theme: ThemeKind;
      readonly side: 0 | 1;
      readonly chunk: number;
    }
  | { readonly type: "close"; readonly doc: number };

export type HighlightResponse =
  /** The document cannot be highlighted (unknown or broken language). */
  | { readonly type: "plain"; readonly doc: number }
  | {
      readonly type: "tokens";
      readonly doc: number;
      readonly theme: ThemeKind;
      readonly side: 0 | 1;
      readonly chunk: number;
      /** Offsets into `tokens` per line of the chunk, plus the end. */
      readonly starts: Uint32Array;
      /** Pairs of (token end column, style index). */
      readonly tokens: Uint32Array;
      /** Styles (`color|fontStyle`) added since the last message, starting at `paletteBase`. */
      readonly paletteBase: number;
      readonly palette: string[] | null;
    };

const BY_NAME: Readonly<Record<string, string>> = {
  dockerfile: "docker",
  makefile: "make",
  gnumakefile: "make",
  "cmakelists.txt": "cmake",
  "meson.build": "meson",
  gemfile: "ruby",
  rakefile: "ruby",
  podfile: "ruby",
  justfile: "just",
  "build.bazel": "starlark",
  workspace: "starlark",
  ".bashrc": "bash",
  ".zshrc": "zsh",
  ".gitignore": "ignore",
  ".gitattributes": "ini",
  ".editorconfig": "ini",
};

const BY_EXT: Readonly<Record<string, string>> = {
  h: "cpp",
  hh: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  cc: "cpp",
  cxx: "cpp",
  ipp: "cpp",
  inl: "cpp",
  tpp: "cpp",
  cu: "cpp",
  mm: "objective-cpp",
  m: "objective-c",
  mjs: "js",
  cjs: "js",
  mts: "ts",
  cts: "ts",
  pyi: "py",
  rs: "rust",
  kt: "kotlin",
  kts: "kotlin",
  gradle: "groovy",
  cmake: "cmake",
  sh: "bash",
  zsh: "zsh",
  yml: "yaml",
  jsonc: "jsonc",
  json5: "json5",
  md: "markdown",
  mdx: "mdx",
  htm: "html",
  xhtml: "html",
  svg: "xml",
  plist: "xml",
  csproj: "xml",
  props: "xml",
  targets: "xml",
  ex: "elixir",
  exs: "elixir",
  hs: "haskell",
  ml: "ocaml",
  mli: "ocaml",
  f90: "fortran-free-form",
  f: "fortran-fixed-form",
  tf: "terraform",
  bzl: "starlark",
  cfg: "ini",
  conf: "ini",
  lock: "json",
  txt: "",
};

/** Picks a shiki language for a path, or null for plain text. */
export const languageFor = (path: string, available: readonly string[]): string | null => {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  const known = new Set(available);
  for (const candidate of [BY_NAME[name], BY_EXT[ext], ext]) {
    if (candidate === "") return null;
    if (candidate && known.has(candidate)) return candidate;
  }
  return null;
};
