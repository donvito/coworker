import type { AppColorMode, AppSettings, AppTheme } from "@shared/contracts";
import type { IconName } from "../components/Icon";

export type AppearanceSettings = Pick<AppSettings, "theme" | "colorMode">;
export type AppearancePatch = Partial<AppearanceSettings>;

export const themeOptions: Array<{ id: AppTheme; label: string; description: string }> = [
  { id: "graphite", label: "Graphite", description: "Neutral monochrome, the default" },
  { id: "forest", label: "Forest", description: "Deep green" },
  { id: "ocean", label: "Ocean", description: "Calm navy blue" },
  { id: "plum", label: "Plum", description: "Muted violet" },
  { id: "clay", label: "Clay", description: "Warm terracotta" },
];

export const colorModeOptions: Array<{
  id: AppColorMode;
  label: string;
  description: string;
  icon: IconName;
}> = [
  { id: "light", label: "Light", description: "Bright backgrounds", icon: "sun" },
  { id: "dark", label: "Dark", description: "Dim backgrounds", icon: "moon" },
  { id: "system", label: "System", description: "Match your device", icon: "monitor" },
];
