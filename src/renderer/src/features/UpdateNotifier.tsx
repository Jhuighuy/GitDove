import type { UpdaterStatus } from "@shared/domain";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { api, useEvent } from "@/lib/api";

/** Shows a toast when an over-the-air update has been downloaded. */
export function UpdateNotifier() {
  const shown = useRef<string | null>(null);
  const show = useCallback((s: UpdaterStatus) => {
    if (s.kind !== "ready" || shown.current === s.version) return;
    shown.current = s.version;
    toast.info(`GitDove ${s.version} is ready`, {
      description: "Restart now, or it will be installed when you quit.",
      duration: Infinity,
      action: { label: "Restart", onClick: () => void api("updater.install") },
    });
  }, []);
  useEvent("updater.status", show);
  // The update may have been downloaded before this window loaded.
  useEffect(() => {
    void api("updater.status")
      .then(show)
      .catch(() => {});
  }, [show]);
  return null;
}
