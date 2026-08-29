import type { SharedFolder } from "./contracts";

/**
 * Enabling folders.list/folders.read is not enough on its own: asked what
 * files it can see, a coworker answers from its workspace and reports nothing,
 * because the granted folders never appear in the prompt it reasons from.
 * Naming them here makes the grant part of what the coworker knows it has.
 */
export function formatGrantedFolders(folders: SharedFolder[]): string {
  if (folders.length === 0) return "";
  return [
    "Granted folder access: the user has shared these read-only folders from their computer:",
    ...folders.map((folder) => `- ${folder.alias} — ${folder.path}`),
    "These folders are part of what you have access to. When asked what files, documents, or folders you can see, include them rather than answering only from your coworker workspace. Use folders.list to browse them and folders.read to read a file. You can never create, change, or delete anything inside them.",
  ].join("\n");
}
