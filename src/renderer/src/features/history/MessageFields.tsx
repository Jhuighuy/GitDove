import { useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** Git's conventional limit for a summary line. */
const SUMMARY_LIMIT = 72;

/** A message's summary (first line) and description (after the blank line). */
export const splitMessage = (message: string) => {
  const [summary = "", ...rest] = message.replaceAll("\r\n", "\n").split("\n");
  return { summary, description: rest.join("\n").replace(/^\n+/, "") };
};

/** Joins what {@link splitMessage} split; as typed, so that spaces and new lines survive. */
export const joinMessage = (summary: string, description: string) =>
  description ? `${summary}\n\n${description}` : summary;

/**
 * Summary and description fields for a commit message, like the commit box's. Cmd/Ctrl+Enter
 * calls `onSubmit`, Escape `onCancel`.
 */
export function MessageFields({
  message,
  onChange,
  onSubmit,
  onCancel,
  autoFocus,
  rows = 8,
  className,
}: {
  message: string;
  onChange: (message: string) => void;
  onSubmit?: () => void;
  onCancel?: () => void;
  autoFocus?: boolean;
  rows?: number;
  className?: string;
}) {
  const { summary, description } = splitMessage(message);
  const summaryRef = useRef<HTMLInputElement>(null);
  const left = SUMMARY_LIMIT - summary.length;

  useEffect(() => {
    if (!autoFocus) return;
    const input = summaryRef.current;
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }, [autoFocus]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      onSubmit?.();
    } else if (e.key === "Escape" && onCancel) {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="relative">
        <Input
          ref={summaryRef}
          value={summary}
          aria-label="Summary"
          placeholder="Summary"
          spellCheck
          onChange={(e) => onChange(joinMessage(e.target.value, description))}
          onKeyDown={(e) => {
            // Enter in the summary moves on to the description, as a new paragraph would.
            if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              (e.currentTarget.parentElement?.nextElementSibling as HTMLElement | null)?.focus();
              return;
            }
            onKeyDown(e);
          }}
          className="h-8 rounded-lg pr-10 text-[13px] font-medium"
        />
        <span
          className={cn(
            "pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[11px] tabular-nums",
            left < 0 ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {left}
        </span>
      </div>
      <Textarea
        value={description}
        aria-label="Description"
        placeholder="Description"
        spellCheck
        rows={rows}
        onChange={(e) => onChange(joinMessage(summary, e.target.value))}
        onKeyDown={onKeyDown}
        className="max-h-[50vh] min-h-24 resize-none rounded-lg text-[13px] leading-relaxed [field-sizing:content]"
      />
    </div>
  );
}
