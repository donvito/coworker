import { stat, unlink } from "node:fs/promises";
import { relative } from "node:path";
import type { Artifact } from "@shared/contracts";
import type { CoworkerDatabase } from "@main/db/database";
import { resolveWorkspacePath } from "@main/tools/workspace-path";

export interface ResolvedArtifactFile {
  artifact: Artifact;
  path: string;
}

export async function resolveArtifactFile(
  database: CoworkerDatabase,
  artifactId: string,
): Promise<ResolvedArtifactFile> {
  const artifact = database.getArtifact(artifactId);
  const coworker = database.getCoworker(artifact.coworkerId);
  const workspacePath = relative(coworker.workspacePath, artifact.filePath) || ".";
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
