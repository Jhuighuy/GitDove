import "./styles.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SettingsSync } from "@/components/SettingsSync";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryClient } from "@/lib/queries";
import { App, ErrorBoundary } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* Always "system": the main process sets the app's theme as the system's (`nativeTheme`). */}
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      storageKey="gitdove.theme"
    >
      <SettingsSync />
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delay={500}>
          <div className="h-screen">
            <ErrorBoundary>
              <App />
            </ErrorBoundary>
          </div>
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
