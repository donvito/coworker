import { readFile, writeFile, link, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, extname, join } from 'node:path';
import type { Coworker } from '@shared/contracts';
import type { FileRef } from '@shared/files';
import { declaredWorkspaceContextFile } from '@shared/workspace-context';
import { fileRoots, resolveFile } from './file-access';
/** Resolve the user's saved output preference only when no destination was supplied. */
export function outputRoot(coworker: Coworker, requested?: string): string {
  return requested ?? fileRoots(coworker).find(root => root.defaultOutput)?.id ?? 'workspace';
}
export async function saveNewFile(coworker: Coworker, ref: FileRef, dataPath: string, bytes: Uint8Array): Promise<string> {
  const extension = extname(ref.path);
  for (let suffix = 0; suffix < 1000; suffix++) {
    const candidate = suffix ? ref.path.slice(0, ref.path.length - extension.length) + ` (${suffix})` + extension : ref.path;
    if (ref.root === 'workspace' && declaredWorkspaceContextFile(candidate)) throw new Error('Use approved text tools to change managed context');
    const path = await resolveFile(coworker, { ...ref, path: candidate }, dataPath, true);
    const temporary = join(dirname(path), `.coworker-${randomUUID()}.tmp`);
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    try { await link(temporary, path); return path; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    finally { await unlink(temporary); }
  }
  throw new Error('Could not select an unused output filename');
}
export async function writeGrantedText(coworker: Coworker, ref: FileRef, dataPath: string, content: string, expectedRevision?: string) {
  let filePath = await resolveFile(coworker, ref, dataPath, true);
  if (expectedRevision) {
    const current = await readFile(filePath);
    if (createHash('sha256').update(current).digest('hex') !== expectedRevision) throw new Error('File changed since it was read. Reload and retry.');
    await writeFile(filePath, content, { flag: 'w', mode: 0o600 });
  } else filePath = await saveNewFile(coworker, ref, dataPath, Buffer.from(content));
  return { filePath, revision: createHash('sha256').update(content).digest('hex'), managed: false };
}
