export type StartupMode = "headless" | "desktop";

export interface StartupStatus {
  supported: boolean;
  scope: "user-login";
  registered: boolean;
  enabled: boolean;
  state: "enabled" | "disabled" | "requires-approval" | "not-found" | "unsupported";
  mode: StartupMode;
  dataPath: string;
  selectedProfile: boolean;
  executable: string;
  message?: string;
}
