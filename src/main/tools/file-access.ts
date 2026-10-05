import { lstat, readdir, readFile, stat, realpath } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import type { Coworker } from '@shared/contracts';
import { fileRefSchema, type FileRef, type FileRoot, type FileEntry, type FilePreview } from '@shared/files';
import { folderId, resolveSharedFolderPath } from './shared-folders';
import { resolveWorkspaceOutputPath } from './workspace-text';
import { resolveWorkspacePath } from './workspace-path';
import { readDocumentText } from '@main/integrations/document-text';
import JSZip from 'jszip';

export function fileRoots(coworker: Coworker): FileRoot[] {
  return [{ id: 'workspace', name: 'Workspace', path: coworker.workspacePath, writable: true, defaultOutput: !coworker.sharedFolders.some(f => f.defaultOutput) },
    ...coworker.sharedFolders.map(f => ({ id: f.id ?? folderId(f.path), name: f.alias, path: f.path, writable: f.access === 'read-write', defaultOutput: !!f.defaultOutput }))];
}
export async function resolveFile(coworker: Coworker, input: FileRef, dataPath: string, write = false): Promise<string> {
  const ref = fileRefSchema.parse(input);
  if (ref.root === 'workspace') return write ? resolveWorkspaceOutputPath(coworker.workspacePath, ref.path) : resolveWorkspacePath(coworker.workspacePath, ref.path);
  return resolveSharedFolderPath(coworker.sharedFolders, ref.root, ref.path, { dataPath, write });
}
export async function listFiles(coworker: Coworker, ref: FileRef, dataPath: string): Promise<FileEntry[]> {
  const path = await resolveFile(coworker, ref, dataPath);
  const entries = await readdir(path, { withFileTypes: true });
  if (entries.length > 10000) throw new Error('This folder contains more than 10,000 entries. Open a smaller folder.');
  return (await Promise.all(entries.map(async entry => {
    const details = await lstat(join(path, entry.name));
    return { name: entry.name, path: [ref.path === '.' ? '' : ref.path, entry.name].filter(Boolean).join('/'), type: entry.isSymbolicLink() ? 'symlink' as const : entry.isDirectory() ? 'directory' as const : 'file' as const, size: details.size, modifiedAt: details.mtime.toISOString() };
  }))).sort((a,b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name));
}
export async function previewFile(coworker: Coworker, ref: FileRef, dataPath: string): Promise<FilePreview> {
  const path = await resolveFile(coworker, ref, dataPath);
  const details = await stat(path);
  if (!details.isFile()) throw new Error('Select a regular file to preview');
  const name = basename(path), extension = extname(path).toLowerCase();
  if (details.size <= 10_000_000 && ['.png','.jpg','.jpeg','.gif','.webp'].includes(extension)) {
    const mime = extension === '.jpg' ? 'jpeg' : extension.slice(1);
    return { kind: 'image', name, content: `data:image/${mime};base64,${(await readFile(path)).toString('base64')}` };
  }
  if (extension === '.zip' && details.size <= 10_000_000) {
    const zip = await JSZip.loadAsync(await readFile(path));
    return { kind: 'text', name, content: Object.keys(zip.files).slice(0,10000).join('\n'), truncated: Object.keys(zip.files).length > 10000 };
  }
  const result = await readDocumentText(path);
  return result.kind === 'text' ? { ...result, content: result.content } : { kind: 'binary', name, content: `${result.mimeType} · ${result.size} bytes\n${result.message}` };
}
export async function artifactRef(coworker: Coworker, filePath: string): Promise<FileRef> {
  const target = await realpath(filePath);
  for (const root of fileRoots(coworker)) {
    const canonical = await realpath(root.path).catch(() => root.path);
    const path = relative(canonical, target);
    if (path && !path.startsWith('..') && !path.startsWith('/')) return { root: root.id, path };
  }
  throw new Error('The file is outside this coworker’s workspace and current folder grants');
}
