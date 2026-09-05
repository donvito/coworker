import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const child = spawn(require("electron"), [fileURLToPath(new URL("../out/main/cli/index.js", import.meta.url)), ...process.argv.slice(2)], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit",
});
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
// Forward signals because shells/supervisors do not always signal the entire process group.
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
