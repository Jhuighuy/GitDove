import type { UpdaterStatus } from "@shared/domain";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { api, useEvent } from "@/lib/api";

/** Shows a toast when an over-the-air update has been downloaded. */
export function UpdateNotifier() {
  const shown = useRef<string | null>(null);
  const revision = useRef(0);
  const show = useCallback((s: UpdaterStatus) => {
    if (s.kind !== "ready" || shown.current === s.version) return;
    shown.current = s.version;
    toast.info(`GitDove ${s.version} is ready`, {
      description: "Restart to apply the update.",
      duration: Infinity,
      action: { label: "Restart", onClick: () => void api("updater.install") },
    });
  }, []);
  useEvent("updater.status", (s) => {
    revision.current++;
    show(s);
  });
  useEffect(() => {
    const requestedAt = revision.current;
    void api("updater.status")
      .then((s) => {
        if (revision.current === requestedAt) show(s);
      })
      .catch(() => {});
  }, [show]);
  return null;
}
