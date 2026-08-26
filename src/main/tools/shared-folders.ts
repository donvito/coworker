import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { SharedFolder } from "@shared/contracts";

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
  paths: readonly string[],
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
    const trimmed = requested.trim();
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
    folders.push({ path: canonical, alias: uniqueAlias(basename(canonical), takenAliases) });
  }
  return folders;
}

/**
 * Resolve a read path inside a granted shared folder. Strictly read-only:
 * nothing is ever created, the target must exist, and symlinks may not lead
 * outside the granted folder or into the app's data directory.
 */
export async function resolveSharedFolderPath(
  folders: readonly SharedFolder[],
  alias: string,
  requestedPath: string,
  options: { dataPath?: string } = {},
): Promise<string> {
  const folder = folders.find((candidate) => candidate.alias === alias);
  if (!folder) {
    const available = folders.map((candidate) => candidate.alias).join(", ") || "none";
    throw new Error(`Unknown shared folder "${alias}". Available folders: ${available}`);
  }
  validateRelativePath(requestedPath);

  let root: string;
  try {
    root = await realpath(folder.path);
  } catch {
    throw new Error(`Shared folder "${alias}" is no longer available at ${folder.path}`);
  }
  const candidate = resolve(root, requestedPath);
  if (!isInside(root, candidate)) {
    throw new Error("Path traversal outside the shared folder is blocked");
  }

  let target: string;
  try {
    target = await realpath(candidate);
  } catch {
    throw new Error(`${requestedPath} was not found in shared folder "${alias}"`);
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
