import { mkdirSync } from "node:fs";
import { isAbsolute, join, parse, resolve } from "node:path";

export interface AppProfile {
  dataPath: string;
  sessionPath: string;
  label: "Production" | "Development" | "Custom";
}

export function resolveAppProfile(input: {
  override?: string;
  isPackaged: boolean;
  appDataPath: string;
  defaultUserDataPath: string;
}): AppProfile {
  const override = input.override?.trim();
  let dataPath: string;
  let label: AppProfile["label"];

  if (override) {
    if (!isAbsolute(override)) {
      throw new Error("COWORKER_DATA_PATH must be an absolute directory");
    }
    dataPath = resolve(override);
    label = "Custom";
  } else if (!input.isPackaged) {
    dataPath = join(input.appDataPath, "Coworker Development");
    label = "Development";
  } else {
    dataPath = resolve(input.defaultUserDataPath);
    label = "Production";
  }

  if (dataPath === parse(dataPath).root) {
    throw new Error("Coworker data cannot be stored at the filesystem root");
  }

  return {
    dataPath,
    sessionPath: join(dataPath, "session"),
    label,
  };
}

export function prepareAppProfile(profile: AppProfile): void {
  mkdirSync(profile.dataPath, { recursive: true, mode: 0o700 });
  mkdirSync(profile.sessionPath, { recursive: true, mode: 0o700 });
}
