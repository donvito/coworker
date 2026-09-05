import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export async function installCli(input: {
  executable: string; entry: string; appPath: string; packaged: boolean; directory?: string; defaultUserDataPath: string; appDataPath: string;
}) {
  const directory = input.directory ?? (process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? homedir(), "Coworker", "bin") : join(homedir(), ".local", "bin"));
  if (!isAbsolute(directory)) throw new Error("CLI installation directory must be absolute");
  await mkdir(directory, { recursive: true });
  const file = join(directory, process.platform === "win32" ? "coworker.cmd" : "coworker");
  const config = Buffer.from(JSON.stringify(input)).toString("base64");
  // Resolve packaged entrypoints inside the currently running bundle. In particular,
  // AppImage mount paths change on every launch and must never be baked into PATH.
  const portableBootstrap = input.packaged
    ? "const p=require('node:path');const e=p.join(p.dirname(process.execPath),...(process.platform==='darwin'?['..','Resources']:['resources']),'app.asar','out','main','cli','index.js');process.argv.splice(1,0,e);import(require('node:url').pathToFileURL(e).href).catch(e=>{console.error(e.message);process.exitCode=1})"
    : "const c=JSON.parse(Buffer.from(process.env.COWORKER_LAUNCH_CONFIG,'base64').toString('utf8'));process.argv.splice(1,0,c.entry);import(require('node:url').pathToFileURL(c.entry).href).catch(e=>{console.error(e.message);process.exitCode=1})";
  const content = process.platform === "win32"
    ? `@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "ELECTRON_RUN_AS_NODE=1"\r\nset "COWORKER_LAUNCH_CONFIG=${config}"\r\n"${input.executable.replaceAll("%", "%%")}" -e "${portableBootstrap}" -- %*\r\nexit /b %errorlevel%\r\n`
    : `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexport COWORKER_LAUNCH_CONFIG=${shellQuote(config)}\nexec ${shellQuote(input.executable)} -e ${shellQuote(portableBootstrap)} -- "$@"\n`;
  // Installation is explicit, but do not replace an unrelated command.
  await writeFile(file, content, { flag: "wx", mode: 0o755 });
  await chmod(file, 0o755);
  return { path: file, message: `Add ${directory} to PATH to use coworker.` };
}
