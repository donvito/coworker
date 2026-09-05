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
    headless: argv.includes("--headless"),
    dataPath: value("--data-path"),
    installCli: argv.includes("--install-cli"),
    binDirectory: value("--bin-dir"),
  };
}
