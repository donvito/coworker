import { stat, unlink } from "node:fs/promises";
import { relative, sep } from "node:path";
import type { Artifact } from "@shared/contracts";
import type { CoworkerDatabase } from "@main/db/database";
import { resolveWorkspacePath } from "@main/tools/workspace-path";

export interface ResolvedArtifactFile {
  artifact: Artifact;
  path: string;
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

export async function resolveArtifactFile(
  database: CoworkerDatabase,
  artifactId: string,
): Promise<ResolvedArtifactFile> {
  const artifact = database.getArtifact(artifactId);
  const coworker = database.getCoworker(artifact.coworkerId);
  const workspacePath = workspaceRelativePath(coworker.workspacePath, artifact.filePath) || ".";
  const path = await resolveWorkspacePath(coworker.workspacePath, workspacePath);
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
  try {
    const { path } = await resolveArtifactFile(database, artifactId);
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  database.deleteArtifact(artifactId);
  return artifact;
}
