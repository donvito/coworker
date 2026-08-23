// The macOS Dock tooltip and menu-bar title come from CFBundleName in the
// Info.plist of the bundle that is actually running. In development that
// bundle is node_modules/electron/dist/Electron.app, so it reads "Electron"
// no matter what app.setName() is given — the Electron docs are explicit that
// setName "does not affect the name used by the operating system".
//
// Packaged builds are already correct: electron-builder writes CFBundleName
// from build.productName. This stamps the same name onto the development
// bundle so dev matches the shipped app. It is a no-op off macOS and when the
// name is already stamped, and pnpm restores the pristine bundle on reinstall.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

if (process.platform !== "darwin") process.exit(0);

const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const productName = pkg.productName ?? pkg.build?.productName;
if (!productName) process.exit(0);

let plist;
try {
  const electronRoot = dirname(require.resolve("electron/package.json"));
  plist = join(electronRoot, "dist", "Electron.app", "Contents", "Info.plist");
} catch {
  process.exit(0);
}
if (!existsSync(plist)) process.exit(0);

function read(key) {
  try {
    return execFileSync("plutil", ["-extract", key, "raw", plist], {
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

if (read("CFBundleName") === productName) process.exit(0);

// Edit a copy and swap it in rather than editing in place: the bundle file may
// be hard-linked into a package store, and writing through the link would
// change the name for every project sharing it.
const staged = join(tmpdir(), `coworker-dev-info-${process.pid}.plist`);
try {
  copyFileSync(plist, staged);
  for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
    execFileSync("plutil", ["-replace", key, "-string", productName, staged]);
  }
  rmSync(plist);
  copyFileSync(staged, plist);
  console.log(`Development Electron bundle now reports as "${productName}".`);
} catch (error) {
  // Never block `pnpm dev` over a cosmetic name.
  console.warn(`Could not rename the development Electron bundle: ${error.message}`);
} finally {
  rmSync(staged, { force: true });
}
