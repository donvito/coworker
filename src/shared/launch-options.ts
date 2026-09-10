// `--headless` is also a Chromium switch. Passing it to Electron installs a
// synthetic 1x display, even if this background process later opens a window.
export const backgroundLaunchSwitch = "--coworker-headless";

/** Migrate old executable invocations before acquiring a profile lock. */
export function retinaSafeRelaunchArguments(argv: string[]): string[] | null {
  return argv.includes("--headless")
    ? argv.map((argument) => argument === "--headless" ? backgroundLaunchSwitch : argument)
    : null;
}

/** Options understood by the desktop executable before it acquires its profile lock. */
export function parseLaunchOptions(argv: string[]) {
  const value = (name: string) => {
    const index = argv.indexOf(name);
    if (index < 0) return undefined;
    const result = argv[index + 1];
    if (!result || result.startsWith("--")) throw new Error(`${name} requires a value`);
    return result;
  };
  return {
    headless: argv.includes(backgroundLaunchSwitch) || argv.includes("--headless"),
    dataPath: value("--data-path"),
    installCli: argv.includes("--install-cli"),
    binDirectory: value("--bin-dir"),
  };
}

export function applyLoginStartup(
  options: ReturnType<typeof parseLaunchOptions>,
  configuration: { dataPath: string; mode: "headless" | "desktop" } | null,
) {
  if (!configuration || options.dataPath !== undefined || options.installCli) return options;
  return { ...options, dataPath: configuration.dataPath, headless: options.headless || configuration.mode === "headless" };
}

export function loginRelaunchArguments(
  options: ReturnType<typeof parseLaunchOptions>,
  configuration: { dataPath: string; mode: "headless" | "desktop" } | null,
): string[] | null {
  const selected = applyLoginStartup(options, configuration);
  if (selected === options) return null;
  return ["--data-path", selected.dataPath!, ...(selected.headless ? [backgroundLaunchSwitch] : [])];
}

export function shouldShowSecondInstance(argv: string[], additionalData: unknown): boolean {
  const headless = additionalData !== null && typeof additionalData === "object" &&
    "headless" in additionalData && additionalData.headless === true;
  return !headless && !argv.includes(backgroundLaunchSwitch) && !argv.includes("--headless");
}
