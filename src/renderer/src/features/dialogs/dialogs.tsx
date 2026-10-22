import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface PromptOptions {
  readonly title: string;
  readonly description?: string;
  readonly label?: string;
  readonly defaultValue?: string;
  readonly placeholder?: string;
  readonly confirmLabel?: string;
  readonly validate?: (value: string) => string | null;
  /** Optional checkbox shown under the input. */
  readonly checkbox?: { readonly label: string; readonly defaultChecked: boolean };
  /** Optional multi-line field shown under the input (e.g. a tag message). */
  readonly details?: { readonly label: string; readonly placeholder?: string };
}

/** Result of {@link prompt}; `details` is the trimmed multi-line field ("" when unused). */
export interface PromptResult {
  readonly value: string;
  readonly checked: boolean;
  readonly details: string;
}

interface ConfirmOptions {
  readonly title: string;
  readonly description?: string;
  readonly confirmLabel?: string;
  readonly destructive?: boolean;
}

type Request = { readonly id: number } & (
  | {
      kind: "prompt";
      options: PromptOptions;
      resolve: (v: PromptResult | null) => void;
    }
  | { kind: "confirm"; options: ConfirmOptions; resolve: (v: boolean) => void }
);

const useDialogs = create<{ current: Request | null }>()(() => ({ current: null }));

let nextId = 0;

const show = (request: Request) => {
  const prev = useDialogs.getState().current;
  if (prev?.kind === "prompt") prev.resolve(null);
  else if (prev?.kind === "confirm") prev.resolve(false);
  useDialogs.setState({ current: request });
};

/** Asks the user for a line of text. Resolves to `null` when cancelled. */
export const prompt = (options: PromptOptions) =>
  new Promise<PromptResult | null>((resolve) =>
    show({ id: ++nextId, kind: "prompt", options, resolve }),
  );

/** Asks the user to confirm an action. */
export const confirm = (options: ConfirmOptions) =>
  new Promise<boolean>((resolve) => show({ id: ++nextId, kind: "confirm", options, resolve }));

export function DialogHost() {
  const current = useDialogs((s) => s.current);
  const close = () => useDialogs.setState({ current: null });

  return (
    <Dialog
      open={current !== null}
      onOpenChange={(open) => {
        if (open || !current) return;
        if (current.kind === "prompt") current.resolve(null);
        else current.resolve(false);
        close();
      }}
    >
      {current?.kind === "prompt" && (
        <PromptBody
          // Each prompt starts from its own values, also when it follows another one at once.
          key={current.id}
          options={current.options}
          onDone={(v) => {
            current.resolve(v);
            close();
          }}
        />
      )}
      {current?.kind === "confirm" && (
        <DialogContent key={current.id} className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{current.options.title}</DialogTitle>
            {current.options.description && (
              <DialogDescription className="whitespace-pre-line">
                {current.options.description}
              </DialogDescription>
            )}
          </DialogHeader>
          <DialogFooter>
            <Button
              // A stray Enter must not delete or discard anything.
              autoFocus={current.options.destructive === true}
              variant="ghost"
              onClick={() => {
                current.resolve(false);
                close();
              }}
            >
              Cancel
            </Button>
            <Button
              autoFocus={current.options.destructive !== true}
              variant={current.options.destructive ? "destructive" : "default"}
              onClick={() => {
                current.resolve(true);
                close();
              }}
            >
              {current.options.confirmLabel ?? "OK"}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

function PromptBody({
  options,
  onDone,
}: {
  options: PromptOptions;
  onDone: (v: PromptResult | null) => void;
}) {
  const [value, setValue] = useState(options.defaultValue ?? "");
  const [checked, setChecked] = useState(options.checkbox?.defaultChecked ?? false);
  const [details, setDetails] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const error = value ? (options.validate?.(value) ?? null) : null;

  useEffect(() => {
    input.current?.select();
  }, []);

  const submit = () => {
    if (!value.trim() || error) return;
    onDone({ value: value.trim(), checked, details: details.trim() });
  };

  return (
    <DialogContent className="sm:max-w-md" showCloseButton={false}>
      <DialogHeader>
        <DialogTitle>{options.title}</DialogTitle>
        {options.description && <DialogDescription>{options.description}</DialogDescription>}
      </DialogHeader>
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {options.label && <Label htmlFor="prompt-input">{options.label}</Label>}
        <Input
          id="prompt-input"
          ref={input}
          autoFocus
          value={value}
          placeholder={options.placeholder}
          aria-invalid={error !== null}
          onChange={(e) => setValue(e.target.value)}
          spellCheck={false}
        />
        {error && <p className="text-destructive text-xs">{error}</p>}
        {options.details && (
          <>
            <Label htmlFor="prompt-details" className="mt-1">
              {options.details.label}
            </Label>
            <Textarea
              id="prompt-details"
              value={details}
              placeholder={options.details.placeholder}
              onChange={(e) => setDetails(e.target.value)}
              onKeyDown={(e) => {
                // Enter adds a line here; Cmd/Ctrl+Enter submits, but not while an
                // input method is composing text (its keystrokes report key "Process").
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              className="max-h-48 min-h-20 resize-none"
            />
          </>
        )}
        {options.checkbox && (
          <Label className="flex items-center gap-2 font-normal">
            <Checkbox checked={checked} onCheckedChange={(c) => setChecked(c)} />
            {options.checkbox.label}
          </Label>
        )}
      </form>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onDone(null)}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!value.trim() || error !== null}>
          {options.confirmLabel ?? "OK"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/** Validation for branch and tag names (the rules of `git check-ref-format --branch`). */
export const validateRefName = (name: string): string | null => {
  if (/\s/.test(name)) return "Names cannot contain spaces";
  // oxlint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f~^:?*[\\]|\.\.|@\{/.test(name) || name === "@")
    return "Name contains invalid characters";
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith("."))
    return "Invalid name";
  if (name.includes("//")) return "Names cannot contain empty parts (//)";
  const parts = name.split("/");
  if (parts.some((p) => p.startsWith("."))) return "Name parts cannot start with a dot";
  if (parts.some((p) => p.endsWith(".lock"))) return "Name parts cannot end with .lock";
  return null;
};
