import type { RepoId } from "@shared/domain";
import type { ComponentProps } from "react";
import { ContextMenuItem } from "@/components/ui/context-menu";
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
