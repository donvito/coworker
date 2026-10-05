import { lstat, realpath, readdir, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CoworkerDatabase } from '@main/db/database';
import { fileRefSchema, type FileRef, type FileDeleteResult } from '@shared/files';
import { fileRoots, resolveFile } from '@main/tools/file-access';
import { workspaceContextFiles } from '@shared/workspace-context';

function contains(parent: string, path: string) {
  const rel = relative(parent, path);
  return !rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function revision(path: string): Promise<string> {
  const hash = createHash('sha256');
  let count = 0;
  async function visit(candidate: string): Promise<void> {
    if (++count > 10000) throw new Error('Folder exceeds 10,000 entries. Delete smaller subfolders first.');
    const info = await lstat(candidate);
    hash.update(JSON.stringify([candidate, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]));
    // Include links in the snapshot but never follow them outside the selected folder.
    if (info.isDirectory() && !info.isSymbolicLink()) {
      for (const child of (await readdir(candidate)).sort()) await visit(join(candidate, child));
    }
  }
  await visit(path);
  return hash.digest('hex');
}

/** The confirmation and OS trash operation are supplied only by the native UI boundary. */
export async function deleteWorkFiles(database: CoworkerDatabase, dataPath: string, coworkerId: string,
  input: FileRef[], confirm: (paths: string[], permanentFolders: string[]) => Promise<boolean>, trash: (path: string) => Promise<void>): Promise<FileDeleteResult> {
  const refs = [...new Map(z.array(fileRefSchema).min(1).max(100).parse(input).map(ref => [JSON.stringify(ref), ref])).values()];
  async function inspect(ref: FileRef) {
    const owner = database.getCoworker(coworkerId);
    const path = await resolveFile(owner, ref, dataPath);
    await resolveFile(owner, ref, dataPath, true);
    const root = fileRoots(owner).find(root => root.id === ref.root);
    if (!root) throw new Error('Folder access was revoked');
    if (path === await realpath(root.path)) throw new Error('Workspace and granted-folder roots cannot be deleted');
    let lexical = root.path;
    for (const segment of ref.path.replaceAll('\\', '/').split('/').filter(part => part && part !== '.')) {
      lexical = join(lexical, segment);
      if ((await lstat(lexical)).isSymbolicLink()) throw new Error('Symbolic links cannot be deleted from the file explorer');
    }
    const info = await lstat(path);
    if (!info.isFile() && !info.isDirectory()) throw new Error('Only regular files and folders can be deleted');
    if (info.isDirectory()) {
      for (const context of workspaceContextFiles) {
        const managed = await realpath(join(owner.workspacePath, context.path)).catch(() => null);
        if (managed && contains(path, managed)) throw new Error('Folders containing managed memory files cannot be deleted');
      }
    }
    return { ref, path, directory: info.isDirectory(), revision: await revision(path) };
  }
  const inspected = await Promise.all(refs.map(inspect));
  const unique = [...new Map(inspected.map(target => [target.path, target])).values()];
  const targets = unique.filter(target => !unique.some(parent => parent !== target && parent.directory && contains(parent.path, target.path)));
  const result: FileDeleteResult = { deleted: [], permanentlyDeleted: [], trashed: [], errors: [], cancelled: false };
  if (!await confirm(targets.map(target => target.path), targets.filter(target => target.directory).map(target => target.path))) return { ...result, cancelled: true };
  for (const target of targets) {
    try {
      const current = await inspect(target.ref);
      if (current.path !== target.path || current.revision !== target.revision) throw new Error(`${target.directory ? 'Folder contents' : 'File'} changed while confirmation was open. Refresh and try again.`);
      const artifacts = [];
      for (const artifact of database.listArtifacts()) {
        const artifactPath = await realpath(artifact.filePath).catch(() => resolve(artifact.filePath));
        if (artifactPath === current.path || (current.directory && (contains(current.path, artifactPath) || contains(current.path, resolve(artifact.filePath))))) artifacts.push(artifact);
      }
      if (current.directory) await rm(current.path, { recursive: true, force: false });
      else await trash(current.path);
      const deleted = inspected.filter(item => item.path === current.path || (current.directory && contains(current.path, item.path))).map(item => item.ref);
      result.deleted.push(...deleted);
      if (current.directory) result.permanentlyDeleted.push(target.ref);
      else result.trashed.push(target.ref);
      const removed = new Set<string>();
      for (const artifact of artifacts) {
        const key = JSON.stringify([artifact.coworkerId, artifact.filePath]);
        if (!removed.has(key)) { database.deleteArtifact(artifact.id); removed.add(key); }
      }
      database.addActivity({ coworkerId, taskId: null, type: 'files.deleted', summary: `${current.directory ? 'Permanently deleted folder and contents' : 'Moved to Trash'}: ${current.path}`, metadata: { ref: target.ref, permanent: current.directory } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push({ ref: target.ref, message });
      database.addActivity({ coworkerId, taskId: null, type: 'files.delete.failed', summary: message, metadata: { ref: target.ref } });
    }
  }
  return result;
}
