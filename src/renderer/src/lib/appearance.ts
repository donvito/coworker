import { useEffect } from "react";
import { appColorModes, appThemes, type AppSettings } from "@shared/contracts";

type Appearance = Pick<AppSettings, "theme" | "colorMode">;

const storageKey = "coworker.appearance";
const defaultAppearance: Appearance = { theme: "graphite", colorMode: "light" };

function readCachedAppearance(): Appearance {
  try {
    const cached: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (!cached || typeof cached !== "object") return defaultAppearance;
    const { theme, colorMode } = cached as Record<string, unknown>;
    return {
      theme: appThemes.find((candidate) => candidate === theme) ?? defaultAppearance.theme,
      colorMode:
        appColorModes.find((candidate) => candidate === colorMode) ?? defaultAppearance.colorMode,
    };
  } catch {
    return defaultAppearance;
  }
}

function applyAppearance({ theme, colorMode }: Appearance, systemDark: boolean) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.colorMode =
    colorMode === "system" ? (systemDark ? "dark" : "light") : colorMode;
}

/** Restore the last appearance before React paints the loading screen. */
export function initializeAppearance() {
  applyAppearance(readCachedAppearance(), window.matchMedia("(prefers-color-scheme: dark)").matches);
}

export function useAppearance(settings?: Appearance) {
  const theme = settings?.theme;
  const colorMode = settings?.colorMode;

  useEffect(() => {
    // The database is authoritative once bootstrap completes; the cache only
    // supplies the appearance while the local workroom is opening.
    const appearance = theme && colorMode ? { theme, colorMode } : readCachedAppearance();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => applyAppearance(appearance, media.matches);
    apply();

    if (theme && colorMode) {
      try {
        localStorage.setItem(storageKey, JSON.stringify(appearance));
      } catch {
        // Persistence still lives in app settings if browser storage is unavailable.
      }
    }

    if (appearance.colorMode === "system") {
      media.addEventListener("change", apply);
      return () => media.removeEventListener("change", apply);
    }
  }, [theme, colorMode]);
}
