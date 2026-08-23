import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

function validateRelativePath(path: string): void {
  if (!path || path.includes("\0") || isAbsolute(path)) {
    throw new Error("A relative workspace path is required");
  }
  const segments = path.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new Error("Path traversal outside the coworker workspace is blocked");
  }
}

async function createSafeParent(root: string, parent: string): Promise<void> {
  const fromRoot = relative(root, parent);
  if (!fromRoot) return;

  let current = root;
  for (const segment of fromRoot.split(sep)) {
    current = join(current, segment);
    try {
      const stats = await lstat(current);
      if (!stats.isDirectory() && !stats.isSymbolicLink()) {
        throw new Error("A workspace parent path is not a directory");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current);
    }

    const resolved = await realpath(current);
    if (!isInside(root, resolved)) {
      throw new Error("Workspace symlinks may not escape the approved root");
    }
  }
}

export async function resolveWorkspacePath(
  workspaceRoot: string,
  requestedPath: string,
  options: { createParent?: boolean } = {},
): Promise<string> {
  validateRelativePath(requestedPath);
  await mkdir(workspaceRoot, { recursive: true });
  const root = await realpath(workspaceRoot);
  const candidate = resolve(root, requestedPath);
  if (!isInside(root, candidate)) {
    throw new Error("Path traversal outside the coworker workspace is blocked");
  }

  const parent = candidate === root ? root : dirname(candidate);
  if (options.createParent) await createSafeParent(root, parent);

  const existingParent = await realpath(parent);
  if (!isInside(root, existingParent)) {
    throw new Error("Workspace symlinks may not escape the approved root");
  }

  try {
    const stats = await lstat(candidate);
    if (stats.isSymbolicLink()) {
      const target = await realpath(candidate);
      if (!isInside(root, target)) {
        throw new Error("Workspace symlinks may not escape the approved root");
      }
      return target;
    }
    const target = await realpath(candidate);
    if (!isInside(root, target)) {
      throw new Error("Workspace symlinks may not escape the approved root");
    }
    return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && options.createParent) {
      return candidate;
    }
    throw error;
  }
}
