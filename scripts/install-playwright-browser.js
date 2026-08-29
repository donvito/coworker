import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const packagePath = require.resolve("playwright/package.json");
const cliPath = join(dirname(packagePath), "cli.js");
const browserPath = join(dirname(dirname(packagePath)), "playwright-core", ".local-browsers");
if (existsSync(browserPath)) {
  for (const entry of readdirSync(browserPath, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith("chromium_headless_shell-")) {
      rmSync(join(browserPath, entry.name), { recursive: true, force: true });
    }
  }
}
const result = spawnSync(process.execPath, [cliPath, "install", "--no-shell", "chromium"], {
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: "0" },
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
