import type { FileEntry, FileRef, FileRoot } from '@shared/files';

export type LocatedFile = FileEntry & { root: string };
export const fileKey = (ref: FileRef) => JSON.stringify([ref.root, ref.path]);

/** Enumerate authorized roots without following symlinks; stop when the view changes. */
export async function collectFiles(
  roots: FileRoot[], list: (ref: FileRef) => Promise<FileEntry[]>,
  cancelled: () => boolean, limit = 10000,
): Promise<{ entries: LocatedFile[]; warnings: string[] }> {
  const queue: FileRef[] = roots.map(root => ({ root: root.id, path: '.' }));
  const entries: LocatedFile[] = [], warnings: string[] = [];
  let scanned = 0;
  for (let index = 0; index < queue.length && !cancelled(); index++) {
    const location = queue[index]!;
    try {
      const children = await list(location);
      if (cancelled()) break;
      for (const child of children) {
        if (++scanned > limit) {
          warnings.push(`Showing a partial list after scanning ${limit.toLocaleString()} entries. Open a folder to browse further.`);
          return { entries, warnings };
        }
        if (child.type === 'directory') queue.push({ root: location.root, path: child.path });
        else if (child.type === 'file') entries.push({ ...child, root: location.root });
      }
    } catch (error) {
      warnings.push(`${roots.find(root => root.id === location.root)?.name ?? location.root} / ${location.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { entries, warnings };
}
