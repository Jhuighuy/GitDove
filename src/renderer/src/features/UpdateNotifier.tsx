import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { api, useEvent } from "@/lib/api";

/** Shows a toast when an over-the-air update has been downloaded. */
export function UpdateNotifier() {
  const shown = useRef<string | null>(null);
  useEvent("updater.status", (s) => {
    if (s.kind !== "ready" || shown.current === s.version) return;
    shown.current = s.version;
    toast.info(`GitDove ${s.version} is ready`, {
      description: "Restart to apply the update.",
      duration: Infinity,
      action: { label: "Restart", onClick: () => void api("updater.install") },
    });
  });
  useEffect(() => {
    void api("updater.status").catch(() => {});
  }, []);
  return null;
}
