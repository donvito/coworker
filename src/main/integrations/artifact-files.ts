import { artifactRef, resolveFile } from "@main/tools/file-access";
import { realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import type { Artifact, ArtifactFileStatus } from "@shared/contracts";
import type { CoworkerDatabase } from "@main/db/database";
import { resolveWorkspacePath } from "@main/tools/workspace-path";

export interface ResolvedArtifactFile {
  artifact: Artifact;
  path: string;
}

/** Read-only availability check. Missing external files retain their records so restoration works. */
export async function artifactFileStatus(database: CoworkerDatabase, artifactId: string): Promise<ArtifactFileStatus> {
  let artifact: Artifact;
  try {
    artifact = database.getArtifact(artifactId);
  } catch (error) {
    if (error instanceof Error && error.message === `Artifact ${artifactId} was not found`) return "deleted";
    throw error;
  }
  try {
    // Check the recorded path first: shared-folder resolution can wrap ENOENT.
    const details = await stat(artifact.filePath);
    if (!details.isFile()) return "missing";
    await resolveArtifactFile(database, artifactId);
    return "available";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unavailable";
  }
}

const caseInsensitiveFilesystem =
  process.platform === "darwin" || process.platform === "win32";

function escapesRoot(path: string): boolean {
  return path === ".." || path.startsWith(`..${sep}`);
}

/**
 * Recorded artifact paths are absolute, and their workspace root may have been
 * spelled with different casing than the one stored on the coworker (macOS and
 * Windows resolve `…/Coworker` and `…/coworker` to the same directory). Compare
 * case-insensitively on those platforms so a file inside the workspace is still
 * recognised, keeping the original casing of the tail segments.
 */
export function workspaceRelativePath(workspaceRoot: string, filePath: string): string {
  const direct = relative(workspaceRoot, filePath);
  if (!escapesRoot(direct) || !caseInsensitiveFilesystem) return direct;

  const insensitive = relative(workspaceRoot.toLowerCase(), filePath.toLowerCase());
  if (escapesRoot(insensitive)) return direct;

  const segments = filePath.split(sep);
  return segments.slice(segments.length - insensitive.split(sep).length).join(sep);
}

/**
 * Resolves symlinks so both sides compare in canonical form: recorded artifact
 * paths are realpath-ed at creation, while the stored workspace root may be a
 * symlinked spelling (macOS /tmp → /private/tmp, network volumes). A missing
 * file falls back to its canonical parent so deletions still surface as
 * missing files rather than as bogus traversal errors.
 */
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    try {
      return join(await realpath(dirname(path)), basename(path));
    } catch {
      return path;
    }
  }
}

export async function resolveArtifactFile(
  database: CoworkerDatabase,
  artifactId: string,
): Promise<ResolvedArtifactFile> {
  const artifact = database.getArtifact(artifactId);
  const coworker = database.getCoworker(artifact.coworkerId);
  const [canonicalRoot, canonicalFile] = await Promise.all([
    canonicalPath(coworker.workspacePath),
    canonicalPath(artifact.filePath),
  ]);
  const workspacePath = workspaceRelativePath(canonicalRoot, canonicalFile) || ".";
  const path = escapesRoot(workspacePath)
    ? await resolveFile(coworker, await artifactRef(coworker, artifact.filePath), dirname(database.path))
    : await resolveWorkspacePath(coworker.workspacePath, workspacePath);
  const details = await stat(path);
  if (!details.isFile()) {
    throw new Error(`The file for ${artifact.name} is no longer available`);
  }
  return { artifact, path };
}

export async function deleteArtifactFile(
  database: CoworkerDatabase,
  artifactId: string,
): Promise<Artifact> {
  const artifact = database.getArtifact(artifactId);
  const owner = database.getCoworker(artifact.coworkerId);
  if (escapesRoot(workspaceRelativePath(await canonicalPath(owner.workspacePath), await canonicalPath(artifact.filePath)))) {
    database.deleteArtifact(artifactId);
    return artifact;
  }
  try {
    const { path } = await resolveArtifactFile(database, artifactId);
    const coworker = database.getCoworker(artifact.coworkerId);
    const root = await canonicalPath(coworker.workspacePath);
    if (!escapesRoot(workspaceRelativePath(root, await canonicalPath(path)))) await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  database.deleteArtifact(artifactId);
  return artifact;
}
