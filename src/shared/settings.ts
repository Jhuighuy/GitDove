/**
 * App-wide settings: what they are, their defaults, and how a stored value is normalized, so a
 * hand-edited or older `settings.json` (or a renderer's request) cannot hold a bad value.
 */

export const APP_THEMES = ["light", "dark", "system"] as const;
export type AppTheme = (typeof APP_THEMES)[number];

/** Syntax themes offered for each color scheme: shiki theme name and display name. */
export const SYNTAX_THEMES = {
  light: [
    ["vitesse-light", "Vitesse Light"],
    ["github-light", "GitHub Light"],
    ["light-plus", "Light+ (VS Code)"],
    ["one-light", "One Light"],
    ["min-light", "Min Light"],
    ["solarized-light", "Solarized Light"],
    ["catppuccin-latte", "Catppuccin Latte"],
    ["rose-pine-dawn", "Rosé Pine Dawn"],
    ["everforest-light", "Everforest Light"],
    ["gruvbox-light-medium", "Gruvbox Light"],
    ["kanagawa-lotus", "Kanagawa Lotus"],
  ],
  dark: [
    ["vitesse-dark", "Vitesse Dark"],
    ["github-dark", "GitHub Dark"],
    ["dark-plus", "Dark+ (VS Code)"],
    ["one-dark-pro", "One Dark Pro"],
    ["min-dark", "Min Dark"],
    ["solarized-dark", "Solarized Dark"],
    ["catppuccin-mocha", "Catppuccin Mocha"],
    ["rose-pine", "Rosé Pine"],
    ["everforest-dark", "Everforest Dark"],
    ["gruvbox-dark-medium", "Gruvbox Dark"],
    ["kanagawa-wave", "Kanagawa Wave"],
    ["dracula", "Dracula"],
    ["nord", "Nord"],
    ["tokyo-night", "Tokyo Night"],
    ["monokai", "Monokai"],
  ],
} as const satisfies Record<"light" | "dark", readonly (readonly [string, string])[]>;

export type ColorScheme = keyof typeof SYNTAX_THEMES;
export type SyntaxTheme = (typeof SYNTAX_THEMES)[ColorScheme][number][0];

export const DATE_STYLES = ["relative", "absolute"] as const;
export type DateStyle = (typeof DATE_STYLES)[number];

/** Terminals GitDove knows how to open, on some platform (see `src/main/terminals.ts`). */
export const TERMINAL_IDS = [
  // macOS
  "terminal",
  "iterm",
  "ghostty",
  "wezterm",
  "kitty",
  "alacritty",
  "warp",
  // Windows
  "wt",
  "pwsh",
  "powershell",
  "cmd",
  "gitbash",
  // Linux (and some of the above)
  "x-terminal-emulator",
  "gnome-terminal",
  "ptyxis",
  "konsole",
  "xfce4-terminal",
  "foot",
  "xterm",
] as const;

/** A terminal the user can choose. */
export interface TerminalInfo {
  readonly id: string;
  readonly name: string;
  readonly installed: boolean;
}

/** The name of an application or program, e.g. `Ghostty` for `/Applications/Ghostty.app`. */
export const programName = (path: string): string =>
  // Either separator: a Windows path is one wherever it is checked.
  path
    .split(/[\\/]/)
    .at(-1)!
    .replace(/\.(app|exe)$/i, "");

export const TAB_SIZES = [2, 4, 8] as const;
/** Interface zoom levels, as `webContents` zoom factors. */
export const ZOOM_LEVELS = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const;
export const MIN_CODE_FONT_SIZE = 10;
export const MAX_CODE_FONT_SIZE = 20;

export interface Settings {
  readonly theme: AppTheme;
  readonly syntaxThemeLight: SyntaxTheme;
  readonly syntaxThemeDark: SyntaxTheme;
  /** Font family of code (diffs, hashes); empty for the bundled JetBrains Mono. */
  readonly codeFont: string;
  /** Diff text size, in pixels. */
  readonly codeFontSize: number;
  readonly ligatures: boolean;
  /** One of {@link ZOOM_LEVELS}. */
  readonly zoom: number;
  /** How commit dates read in lists: "3 days ago", or the date itself. */
  readonly dates: DateStyle;
  /** Whether author pictures are looked up online (GitHub, GitLab, Gravatar). */
  readonly avatars: boolean;
  /** One of {@link TAB_SIZES}. */
  readonly tabSize: number;
  /**
   * Terminal to open repositories in: empty for the default, one of {@link TERMINAL_IDS}, or the
   * path of a program the user chose (which may only open local repositories).
   */
  readonly terminal: string;
  /** Whether updates are checked for (and downloaded) in the background. */
  readonly autoUpdate: boolean;
  /** Whether the tabs of the last session are opened on launch. */
  readonly restoreTabs: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  syntaxThemeLight: "vitesse-light",
  syntaxThemeDark: "vitesse-dark",
  codeFont: "",
  codeFontSize: 12,
  ligatures: true,
  zoom: 1,
  dates: "relative",
  avatars: true,
  tabSize: 4,
  terminal: "",
  autoUpdate: true,
  restoreTabs: true,
};

/** Longest font name or terminal accepted. */
const MAX_TEXT = 200;

const oneOf =
  <T>(values: readonly T[]) =>
  (v: unknown): v is T =>
    values.includes(v as T);

const themeOf = (scheme: ColorScheme) =>
  oneOf<string>(SYNTAX_THEMES[scheme].map(([name]) => name)) as (v: unknown) => v is SyntaxTheme;

/** A single line of text without control characters. */
const isText = (v: unknown): v is string =>
  typeof v === "string" && v.length <= MAX_TEXT && !/\p{Cc}/u.test(v);

const isFontSize = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) >= MIN_CODE_FONT_SIZE && (v as number) <= MAX_CODE_FONT_SIZE;

const isBool = (v: unknown): v is boolean => typeof v === "boolean";

/** Which values each setting accepts. */
export const SETTING_CHECKS: { readonly [K in keyof Settings]: (v: unknown) => v is Settings[K] } =
  {
    theme: oneOf(APP_THEMES),
    syntaxThemeLight: themeOf("light"),
    syntaxThemeDark: themeOf("dark"),
    codeFont: isText,
    codeFontSize: isFontSize,
    ligatures: isBool,
    zoom: oneOf<number>(ZOOM_LEVELS),
    dates: oneOf(DATE_STYLES),
    avatars: isBool,
    tabSize: oneOf<number>(TAB_SIZES),
    terminal: isText,
    autoUpdate: isBool,
    restoreTabs: isBool,
  };

/** Keeps the valid settings of `raw`, trimmed; the others get their defaults. */
export const normalizeSettings = (raw: unknown): Settings => {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    let v = Object.hasOwn(r, key) ? (r as Record<string, unknown>)[key] : undefined;
    if (typeof v === "string") v = v.trim();
    if (SETTING_CHECKS[key](v)) out[key] = v;
  }
  return out as unknown as Settings;
};

/** The zoom level `steps` levels away from `zoom` (or the nearest level, if it is none). */
export const stepZoom = (zoom: number, steps: number): number => {
  let i = ZOOM_LEVELS.findIndex((z) => z >= zoom - 1e-6);
  if (i < 0) i = ZOOM_LEVELS.length - 1;
  return ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, i + steps))]!;
};
