import type { SharedFolder } from "./contracts";
export function formatGrantedFolders(folders: SharedFolder[]): string {
  if (!folders.length) return "";
  return ["Granted folders:", ...folders.map(folder => `- ${folder.alias} — ${folder.path} (root: ${folder.id ?? folder.alias}; ${folder.access ?? "read"}${folder.defaultOutput ? "; default output" : ""})`)].join("\n");
}
