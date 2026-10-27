import {
  type AppTheme,
  type DateStyle,
  MAX_CODE_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  programName,
  SYNTAX_THEMES,
  type SyntaxTheme,
  TAB_SIZES,
  ZOOM_LEVELS,
} from "@shared/settings";
import {
  IconAdjustments,
  IconCode,
  IconGitCommit,
  IconPalette,
  type TablerIcon,
} from "@tabler/icons-react";
import { createContext, type ReactNode, useContext, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ApiResult } from "@shared/ipc";
import { api, isMac, platform, useEvent } from "@/lib/api";
import { cn } from "@/lib/utils";
import { type DiffMode, useLayout } from "@/stores/repo-ui";
import { updateSettings, useSettings, useSettingsStore } from "@/stores/settings";

export const useSettingsDialog = create<{ readonly open: boolean }>()(() => ({ open: false }));

export const showSettings = () => useSettingsDialog.setState({ open: true });

const SECTIONS = [
  { id: "appearance", title: "Appearance", icon: IconPalette },
  { id: "diff", title: "Diffs", icon: IconCode },
  { id: "commits", title: "Commits", icon: IconGitCommit },
  { id: "general", title: "General", icon: IconAdjustments },
] as const satisfies readonly { id: string; title: string; icon: TablerIcon }[];

type SectionId = (typeof SECTIONS)[number]["id"];

/** The settings window, opened from the app menu (Cmd/Ctrl+,) or the status bar. */
export function SettingsDialog() {
  const open = useSettingsDialog((s) => s.open);
  const [section, setSection] = useState<SectionId>("appearance");
  useEvent("menu.command", ({ command }) => {
    if (command === "open-settings") showSettings();
  });

  return (
    <Dialog open={open} onOpenChange={(o) => useSettingsDialog.setState({ open: o })}>
      <DialogContent className="flex h-[min(560px,calc(100vh-4rem))] gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <nav className="bg-muted/40 flex w-44 shrink-0 flex-col gap-0.5 border-r p-2">
          <DialogTitle className="px-2 pt-1 pb-3">Settings</DialogTitle>
          {SECTIONS.map(({ id, title, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-current={section === id ? "page" : undefined}
              className={cn(
                "hover:bg-muted flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
                section === id && "bg-muted text-foreground font-medium",
              )}
              onClick={() => setSection(id)}
            >
              <Icon className="text-muted-foreground size-4" />
              {title}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
          <DialogDescription className="sr-only">
            Changes apply to every window at once.
          </DialogDescription>
          {section === "appearance" && <AppearanceSettings />}
          {section === "diff" && <DiffSettings />}
          {section === "commits" && <CommitSettings />}
          {section === "general" && <GeneralSettings />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AppearanceSettings() {
  const theme = useSettings((s) => s.theme);
  const zoom = useSettings((s) => s.zoom);
  const codeFont = useSettings((s) => s.codeFont);
  const ligatures = useSettings((s) => s.ligatures);
  return (
    <Section title="Appearance">
      <Row label="Theme">
        <Choice<AppTheme>
          value={theme}
          onChange={(v) => void updateSettings({ theme: v })}
          options={[
            ["system", "Match System"],
            ["light", "Light"],
            ["dark", "Dark"],
          ]}
        />
      </Row>
      <Row
        label="Zoom"
        description={`Also ${isMac ? "⌘" : "Ctrl+"}+ and ${isMac ? "⌘" : "Ctrl+"}−.`}
      >
        <Choice<number>
          value={zoom}
          onChange={(v) => void updateSettings({ zoom: v })}
          options={ZOOM_LEVELS.map((z) => [z, `${Math.round(z * 100)}%`])}
        />
      </Row>
      <Row label="Code font" description="Any installed monospace font; empty for JetBrains Mono.">
        <TextSetting
          value={codeFont}
          placeholder="JetBrains Mono"
          onCommit={(v) => void updateSettings({ codeFont: v })}
        />
      </Row>
      <Row label="Font ligatures" description="Draw sequences such as != and -> as one glyph.">
        <Toggle value={ligatures} onChange={(v) => void updateSettings({ ligatures: v })} />
      </Row>
    </Section>
  );
}

function DiffSettings() {
  const light = useSettings((s) => s.syntaxThemeLight);
  const dark = useSettings((s) => s.syntaxThemeDark);
  const fontSize = useSettings((s) => s.codeFontSize);
  const tabSize = useSettings((s) => s.tabSize);
  const mode = useLayout((s) => s.diffMode);
  const setMode = useLayout((s) => s.setDiffMode);
  const sizes = Array.from(
    { length: MAX_CODE_FONT_SIZE - MIN_CODE_FONT_SIZE + 1 },
    (_, i) => MIN_CODE_FONT_SIZE + i,
  );
  return (
    <Section title="Diffs">
      <Row label="Syntax theme (light)">
        <Choice<SyntaxTheme>
          value={light}
          onChange={(v) => void updateSettings({ syntaxThemeLight: v })}
          options={SYNTAX_THEMES.light}
        />
      </Row>
      <Row label="Syntax theme (dark)">
        <Choice<SyntaxTheme>
          value={dark}
          onChange={(v) => void updateSettings({ syntaxThemeDark: v })}
          options={SYNTAX_THEMES.dark}
        />
      </Row>
      <Row label="Font size">
        <Choice<number>
          value={fontSize}
          onChange={(v) => void updateSettings({ codeFontSize: v })}
          options={sizes.map((n) => [n, `${n} px`])}
        />
      </Row>
      <Row label="Tab width">
        <Choice<number>
          value={tabSize}
          onChange={(v) => void updateSettings({ tabSize: v })}
          options={TAB_SIZES.map((n) => [n, `${n} spaces`])}
        />
      </Row>
      <Row label="Layout" description="Also switched with the buttons above a diff.">
        <Choice<DiffMode>
          value={mode}
          onChange={setMode}
          options={[
            ["unified", "Unified"],
            ["split", "Split"],
          ]}
        />
      </Row>
    </Section>
  );
}

function CommitSettings() {
  const dates = useSettings((s) => s.dates);
  const avatars = useSettings((s) => s.avatars);
  return (
    <Section title="Commits">
      <Row label="Dates" description="In the graph and commit lists; tooltips show the full date.">
        <Choice<DateStyle>
          value={dates}
          onChange={(v) => void updateSettings({ dates: v })}
          options={[
            ["relative", "Relative (3 days ago)"],
            ["absolute", "Absolute (2026-10-27 15:04)"],
          ]}
        />
      </Row>
      <Row
        label="Author pictures"
        description="Looks authors up on GitHub, GitLab and Gravatar (by a hash of their email). Off shows initials only."
      >
        <Toggle value={avatars} onChange={(v) => void updateSettings({ avatars: v })} />
      </Row>
    </Section>
  );
}

function GeneralSettings() {
  const restoreTabs = useSettings((s) => s.restoreTabs);
  const autoUpdate = useSettings((s) => s.autoUpdate);
  const terminal = useSettings((s) => s.terminal);
  return (
    <Section title="General">
      <Row label="Reopen tabs on launch">
        <Toggle value={restoreTabs} onChange={(v) => void updateSettings({ restoreTabs: v })} />
      </Row>
      <Row
        label="Check for updates automatically"
        description="Updates download in the background and install when GitDove restarts."
      >
        <Toggle value={autoUpdate} onChange={(v) => void updateSettings({ autoUpdate: v })} />
      </Row>
      <TerminalSetting value={terminal} />
    </Section>
  );
}

/** The value of the "Choose…" item, which asks for a terminal with a file dialog. */
const CHOOSE = "\0choose";

function TerminalSetting({ value }: { value: string }) {
  const [list, setList] = useState<ApiResult<"settings.terminals"> | null>(null);
  // Again for another choice: what it is called, and whether it opens remote repositories.
  useEffect(() => {
    let live = true;
    api("settings.terminals").then(
      (l) => live && setList(l),
      () => {},
    );
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- asked again for a new value
  }, [value]);
  const known = list?.terminals ?? [];
  const defaultName = list?.defaultName ?? "";
  const options: [string, string][] = [
    ["", defaultName ? `Default (${defaultName})` : "Default"],
    // The default one is listed as the default, unless it was chosen by name.
    ...known.flatMap((t): [string, string][] =>
      (t.installed && t.name !== defaultName) || t.id === value
        ? [[t.id, t.installed ? t.name : `${t.name} (not installed)`]]
        : [],
    ),
    // A program the user chose.
    ...(value && !known.some((t) => t.id === value)
      ? [[value, list?.current.name ?? programName(value)] as [string, string]]
      : []),
    [CHOOSE, "Choose…"],
  ];
  return (
    <Row
      label="Terminal"
      description={
        list?.current.remote !== false
          ? "Opens local repositories, and remote ones over ssh."
          : platform === "win32"
            ? "Remote repositories open with ssh in Windows' default terminal."
            : `${list.current.name} opens local repositories; remote ones open in ${defaultName}.`
      }
    >
      <Choice<string>
        value={value}
        options={options}
        onChange={(v) => {
          if (v !== CHOOSE) void updateSettings({ terminal: v });
          else
            useSettingsStore
              .getState()
              .pickTerminal()
              .catch((e: unknown) => {
                toast.error("Cannot use this terminal", { description: (e as Error).message });
              });
        }}
      />
    </Row>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-1 text-sm font-medium">{title}</h2>
      <div className="divide-y">{children}</div>
    </section>
  );
}

/** The id of the control of the {@link Row} around it, which its label names. */
const RowId = createContext<string | undefined>(undefined);

/** A setting: its name and description on the left, its control on the right. */
function Row({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-4 py-3">
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="text-xs font-medium">
          {label}
        </label>
        {description && (
          <p className="text-muted-foreground mt-0.5 text-[11px] leading-snug">{description}</p>
        )}
      </div>
      <div className="flex shrink-0 justify-end">
        <RowId value={id}>{children}</RowId>
      </div>
    </div>
  );
}

function Choice<T extends string | number>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly (readonly [T, string])[];
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => v !== null && onChange(v)}
      items={options.map(([v, label]) => ({ value: v, label }))}
    >
      <SelectTrigger id={useContext(RowId)} className="w-48">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([v, label]) => (
          <SelectItem key={v} value={v}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }) {
  return <Checkbox id={useContext(RowId)} checked={value} onCheckedChange={(c) => onChange(c)} />;
}

/** A text field that saves on Enter or when it loses focus; Escape puts back the saved value. */
function TextSetting({
  value,
  placeholder,
  onCommit,
}: {
  value: string;
  placeholder: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft.trim() !== value) onCommit(draft.trim());
    setDraft(null);
  };
  return (
    <Input
      id={useContext(RowId)}
      className="w-48"
      value={draft ?? value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape" && draft !== null) {
          // Only the edit is cancelled, not the dialog.
          e.stopPropagation();
          setDraft(null);
        }
      }}
    />
  );
}
