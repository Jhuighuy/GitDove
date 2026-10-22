import { APP_THEMES, type AppTheme } from "@shared/ipc";
import { useTheme } from "next-themes";
import { useEffect } from "react";
import { api } from "@/lib/api";

const isAppTheme = (theme: string | undefined): theme is AppTheme =>
  (APP_THEMES as readonly (string | undefined)[]).includes(theme);

/**
 * Tells the main process the app's theme, so that native parts (the window background, the
 * title bar's buttons on Windows and Linux) follow it rather than the system's.
 */
export function ThemeSync() {
  const { theme } = useTheme();
  useEffect(() => {
    if (isAppTheme(theme)) void api("app.setTheme", theme).catch(() => {});
  }, [theme]);
  return null;
}
