import { createHash } from "node:crypto";
import { resolveWorkspacePath } from "./workspace-path";
import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { SharedFolder } from "@shared/contracts";

export function folderId(path: string): string { return "folder-" + createHash("sha256").update(path).digest("hex").slice(0, 24); }

export const maxSharedFolders = 20;

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))
  );
}

function validateRelativePath(path: string): void {
  if (!path || path.includes("\0") || isAbsolute(path)) {
    throw new Error("A relative path inside the shared folder is required");
  }
  const segments = path.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new Error("Path traversal outside the shared folder is blocked");
  }
}

function uniqueAlias(name: string, taken: Set<string>): string {
  const base = name.trim() || "folder";
  let alias = base;
  for (let suffix = 2; taken.has(alias.toLowerCase()); suffix += 1) {
    alias = `${base}-${suffix}`;
  }
  taken.add(alias.toLowerCase());
  return alias;
}

/**
 * Validate user-selected folder paths at configuration time and derive a
 * stable alias for each. Grants are canonicalized through realpath so later
 * confinement checks compare against the true on-disk location.
 */
export async function resolveSharedFolderGrants(
  paths: readonly (string | { path: string; access: "read" | "read-write"; defaultOutput?: boolean })[],
  options: { dataPath: string },
): Promise<SharedFolder[]> {
  if (paths.length > maxSharedFolders) {
    throw new Error(`A coworker can have at most ${maxSharedFolders} shared folders`);
  }
  const dataRoot = await realpath(options.dataPath).catch(() => resolve(options.dataPath));
  const seen = new Set<string>();
  const takenAliases = new Set<string>();
  const folders: SharedFolder[] = [];
  for (const requested of paths) {
    const trimmed = (typeof requested === "string" ? requested : requested.path).trim();
    if (!trimmed || trimmed.includes("\0") || !isAbsolute(trimmed)) {
      throw new Error("Shared folders must be absolute paths");
    }
    let canonical: string;
    try {
      canonical = await realpath(trimmed);
    } catch {
      throw new Error(`Shared folder does not exist: ${trimmed}`);
    }
    const stats = await lstat(canonical);
    if (!stats.isDirectory()) {
      throw new Error(`Shared folder is not a directory: ${trimmed}`);
    }
    if (isInside(dataRoot, canonical)) {
      throw new Error("The app's own data directory cannot be shared with a coworker");
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    const access = typeof requested === "string" ? "read" : requested.access;
    if (access === "read-write" && isInside(canonical, dataRoot)) throw new Error("Writable folders cannot contain the app data directory");
    const defaultOutput = typeof requested !== "string" && requested.defaultOutput === true;
    if (defaultOutput && access !== "read-write") throw new Error("The output folder must allow writing");
    folders.push({ id: folderId(canonical), path: canonical, alias: uniqueAlias(basename(canonical), takenAliases), access, defaultOutput });
  }
  if (folders.filter(folder => folder.defaultOutput).length > 1) throw new Error("Choose only one default output folder");
  return folders;
}

/**
 * Resolve a path inside a granted folder. Reads never create files; writes
 * require an explicit writable grant and create only confined parent folders.
 * Symlinks cannot escape the grant or expose protected application data.
 */
export async function resolveSharedFolderPath(
  folders: readonly SharedFolder[],
  alias: string,
  requestedPath: string,
  options: { dataPath?: string; write?: boolean } = {},
): Promise<string> {
  const folder = folders.find((candidate) => candidate.alias === alias || candidate.id === alias || folderId(candidate.path) === alias);
  if (!folder) {
    const available = folders.map((candidate) => candidate.alias).join(", ") || "none";
    throw new Error(`Unknown shared folder "${alias}". Available folders: ${available}`);
  }
  if (options.write && folder.access !== "read-write") throw new Error("This folder has read-only access");
  validateRelativePath(requestedPath);

  let root: string;
  try {
    root = await realpath(folder.path);
  } catch {
    throw new Error(`Shared folder "${alias}" is no longer available at ${folder.path}`);
  }
  if (options.write && options.dataPath) {
    const dataRoot = await realpath(options.dataPath).catch(() => resolve(options.dataPath!));
    if (isInside(root, dataRoot) || isInside(dataRoot, root)) throw new Error("The app data directory cannot be accessed through writable grants");
  }
  if (root !== folder.path && folder.id) throw new Error(`Shared folder "${alias}" has moved or was replaced. Grant it again in settings.`);
  const candidate = resolve(root, requestedPath);
  if (!isInside(root, candidate)) {
    throw new Error("Path traversal outside the shared folder is blocked");
  }

  let target: string;
  try {
    target = options.write
      ? await resolveWorkspacePath(root, requestedPath, { createParent: true })
      : await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${requestedPath} was not found in shared folder "${alias}"`);
    throw error;
  }
  if (!isInside(root, target)) {
    throw new Error("Shared folder symlinks may not escape the granted folder");
  }
  const protectedDataPath = options.dataPath;
  if (protectedDataPath) {
    const dataRoot = await realpath(protectedDataPath).catch(() => resolve(protectedDataPath));
    if (isInside(dataRoot, target)) {
      throw new Error("The app's own data directory is not readable through shared folders");
    }
  }
  return target;
}
