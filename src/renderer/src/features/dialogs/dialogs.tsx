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
}

interface ConfirmOptions {
  readonly title: string;
  readonly description?: string;
  readonly confirmLabel?: string;
  readonly destructive?: boolean;
}

type Request =
  | {
      kind: "prompt";
      options: PromptOptions;
      resolve: (v: { value: string; checked: boolean } | null) => void;
    }
  | { kind: "confirm"; options: ConfirmOptions; resolve: (v: boolean) => void };

const useDialogs = create<{ current: Request | null }>()(() => ({ current: null }));

const show = (request: Request) => {
  const prev = useDialogs.getState().current;
  if (prev?.kind === "prompt") prev.resolve(null);
  else if (prev?.kind === "confirm") prev.resolve(false);
  useDialogs.setState({ current: request });
};

/** Asks the user for a line of text. Resolves to `null` when cancelled. */
export const prompt = (options: PromptOptions) =>
  new Promise<{ value: string; checked: boolean } | null>((resolve) =>
    show({ kind: "prompt", options, resolve }),
  );

/** Asks the user to confirm an action. */
export const confirm = (options: ConfirmOptions) =>
  new Promise<boolean>((resolve) => show({ kind: "confirm", options, resolve }));

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
          options={current.options}
          onDone={(v) => {
            current.resolve(v);
            close();
          }}
        />
      )}
      {current?.kind === "confirm" && (
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
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
              variant="ghost"
              onClick={() => {
                current.resolve(false);
                close();
              }}
            >
              Cancel
            </Button>
            <Button
              autoFocus
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
  onDone: (v: { value: string; checked: boolean } | null) => void;
}) {
  const [value, setValue] = useState(options.defaultValue ?? "");
  const [checked, setChecked] = useState(options.checkbox?.defaultChecked ?? false);
  const input = useRef<HTMLInputElement>(null);
  const error = value ? (options.validate?.(value) ?? null) : null;

  useEffect(() => {
    input.current?.select();
  }, []);

  const submit = () => {
    if (!value.trim() || error) return;
    onDone({ value: value.trim(), checked });
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
        {options.checkbox && (
          <Label className="flex items-center gap-2 font-normal">
            <Checkbox checked={checked} onCheckedChange={(c) => setChecked(c === true)} />
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

/** Validation for branch and tag names (a subset of `git check-ref-format`). */
export const validateRefName = (name: string): string | null => {
  if (/\s/.test(name)) return "Names cannot contain spaces";
  if (/[~^:?*[\\]|\.\.|@\{/.test(name)) return "Name contains invalid characters";
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith("."))
    return "Invalid name";
  if (name.endsWith(".lock")) return "Names cannot end with .lock";
  return null;
};
