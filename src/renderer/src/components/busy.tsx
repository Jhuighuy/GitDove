import type { RepoId } from "@shared/domain";
import type { ComponentProps, ReactNode } from "react";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { useBusy, writeProps } from "@/stores/busy";

/** A context menu item that changes the repository, disabled while another change runs. */
export function WriteMenuItem({
  repo,
  disabled,
  ...props
}: ComponentProps<typeof ContextMenuItem> & { readonly repo: RepoId }) {
  const busy = useBusy(repo);
  return <ContextMenuItem {...props} {...writeProps(busy, disabled)} />;
}

/**
 * Shows why the wrapped control is disabled when hovered: a disabled button
 * gets no pointer events, so its own title would never show.
 */
export function BusyHint({
  reason,
  className,
  children,
}: {
  readonly reason: string | undefined;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <span title={reason} className={cn("flex", className)}>
      {children}
    </span>
  );
}
