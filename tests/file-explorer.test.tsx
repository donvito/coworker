// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { collectFiles } from '@renderer/lib/file-explorer';
import { WorkspaceFiles } from '@renderer/components/WorkspaceFiles';
import type { FileEntry, FileRef, FileRoot } from '@shared/files';

const roots: FileRoot[] = [
  { id: 'workspace', name: 'Workspace', path: '/workspace', writable: true, defaultOutput: true },
  { id: 'shared', name: 'Reports', path: '/reports', writable: false, defaultOutput: false },
];
const entry = (path: string, type: FileEntry['type'] = 'file'): FileEntry => ({ path, name: path.split('/').at(-1)!, type, size: 20, modifiedAt: new Date().toISOString() });
const list = async ({ root, path }: FileRef): Promise<FileEntry[]> => root === 'shared' ? [entry('same.txt')] : path === '.'
  ? [entry('same.txt'), entry('nested', 'directory'), entry('external-link', 'symlink')]
  : [entry('nested/report.txt')];
afterEach(cleanup);

it('collects nested files with root identity and never follows symlinks', async () => {
  const read = vi.fn(list);
  const result = await collectFiles(roots, read, () => false);
  expect(result.entries.map(file => [file.root, file.path])).toEqual([
    ['workspace', 'same.txt'], ['shared', 'same.txt'], ['workspace', 'nested/report.txt'],
  ]);
  expect(read).toHaveBeenCalledTimes(3);
  expect(result.warnings).toEqual([]);
});

it('reports inaccessible folders and scan limits, and supports cancellation', async () => {
  const result = await collectFiles(roots, async ref => {
    if (ref.root === 'shared') throw new Error('Permission revoked');
    return list(ref);
  }, () => false);
  expect(result.warnings[0]).toContain('Permission revoked');
  expect(result.entries).toHaveLength(2);
  expect((await collectFiles(roots, list, () => false, 1)).warnings[0]).toContain('partial list');
  const read = vi.fn(list);
  expect((await collectFiles(roots, read, () => true)).entries).toEqual([]);
  expect(read).not.toHaveBeenCalled();
});

it('browses the folder tree and exports same-named files from separate roots without a dropdown', async () => {
  const zip = vi.fn().mockResolvedValue('/download/files.zip');
  const preview = vi.fn().mockResolvedValue({ kind: 'text', name: 'same.txt', content: 'Preview from Reports' });
  Object.defineProperty(window, 'coworker', { configurable: true, value: {
    files: { roots: async () => roots, list: (_id: string, ref: FileRef) => list(ref), zip, preview },
    events: { subscribe: () => () => {} },
  } });
  render(<WorkspaceFiles coworkerId="ava" name="Ava" onClose={() => {}} />);
  await screen.findByRole('button', { name: 'Expand Workspace' });
  expect(screen.queryByRole('combobox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Expand Workspace' }));
  const tree = screen.getByRole('navigation', { name: 'Folders' });
  fireEvent.click(await within(tree).findByRole('button', { name: 'nested' }));
  await screen.findByRole('checkbox', { name: 'Select report.txt' });
  fireEvent.click(within(tree).getByRole('button', { name: 'All files' }));
  await waitFor(() => expect(screen.getAllByRole('checkbox', { name: 'Select same.txt' })).toHaveLength(2));
  for (const checkbox of screen.getAllByRole('checkbox', { name: 'Select same.txt' })) fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole('button', { name: 'Download ZIP (2)' }));
  await waitFor(() => expect(zip).toHaveBeenCalledWith('ava', [
    { root: 'workspace', path: 'same.txt' }, { root: 'shared', path: 'same.txt' },
  ]));
  await screen.findByText('Saved to /download/files.zip');
  fireEvent.click(screen.getByRole('button', { name: /same.txt Reports/ }));
  await screen.findByText('Preview from Reports');
  expect(preview).toHaveBeenCalledWith('ava', { root: 'shared', path: 'same.txt' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Filter files' }), { target: { value: 'missing' } });
  await screen.findByText('No files match your search.');
});

it('deletes in place across entity/focus events and preserves remaining selection, preview, and list position', async () => {
  let notify = (_event: { type: string; entity: string }) => {};
  let finishRefresh!: (entries: FileEntry[]) => void;
  const backgroundRead = new Promise<FileEntry[]>(resolve => { finishRefresh = resolve; });
  let deleting = false;
  const remove = vi.fn(async () => {
    deleting = true;
    notify({ type: 'entity.changed', entity: 'artifacts' });
    window.dispatchEvent(new Event('focus'));
    return { cancelled: false, deleted: [{ root: 'workspace', path: 'gone.txt' }], errors: [] };
  });
  Object.defineProperty(window, 'coworker', { configurable: true, value: {
    platform: 'darwin',
    files: {
      roots: async () => [roots[0]],
      list: async () => deleting ? backgroundRead : [entry('gone.txt'), entry('keep.txt')],
      preview: async () => ({ kind: 'text', name: 'keep.txt', content: 'Keep this preview' }),
      prepareDelete: async () => ({ token: 'confirmation', paths: ['/workspace/gone.txt'], permanentFolders: [] }),
      delete: remove,
    },
    events: { subscribe: (listener: typeof notify) => { notify = listener; return () => {}; } },
  } });
  render(<WorkspaceFiles coworkerId="ava" name="Ava" onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: /keep.txt 20 bytes/ }));
  await screen.findByText('Keep this preview');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select keep.txt' }));
  const listNode = document.querySelector('.workspace-file-list');
  const content = document.querySelector('.workspace-files-content')!;
  content.scrollTop = 140;
  fireEvent.click(screen.getByRole('button', { name: 'Delete gone.txt' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Move to Trash' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete gone.txt' })).toBeNull());
  expect(screen.queryByText('Loading files…')).toBeNull();
  expect(document.querySelector('.workspace-file-list')).toBe(listNode);
  expect(content.scrollTop).toBe(140);
  expect(screen.getByText('Keep this preview')).toBeTruthy();
  expect((screen.getByRole('checkbox', { name: 'Select keep.txt' }) as HTMLInputElement).checked).toBe(true);
  finishRefresh([entry('keep.txt')]);
  await screen.findByText('Moved 1 file to Trash.');
  expect(document.querySelector('.workspace-file-list')).toBe(listNode);
  expect(screen.getByText('Keep this preview')).toBeTruthy();
});

it('opens the default output folder initially without overriding later navigation', async () => {
  const read = vi.fn(async (_id: string, ref: FileRef) => list(ref));
  Object.defineProperty(window, 'coworker', { configurable: true, value: {
    files: { roots: async () => roots.map(root => ({ ...root, writable: true, defaultOutput: root.id === 'shared' })), list: read },
    events: { subscribe: () => () => {} },
  } });
  render(<WorkspaceFiles coworkerId="ava" name="Ava" onClose={() => {}} />);
  await screen.findByRole('checkbox', { name: 'Select same.txt' });
  expect(read.mock.calls[0]).toEqual(['ava', { root: 'shared', path: '.' }]);
  const tree = screen.getByRole('navigation', { name: 'Folders' });
  expect(within(tree).getByRole('button', { name: 'Reports' }).getAttribute('aria-current')).toBe('location');
  fireEvent.click(within(tree).getByRole('button', { name: 'Workspace' }));
  await screen.findByRole('checkbox', { name: 'Select nested' });
  fireEvent(window, new Event('focus'));
  await waitFor(() => expect(within(tree).getByRole('button', { name: 'Workspace' }).getAttribute('aria-current')).toBe('location'));
});

it('shows a custom folder warning and supports cancellation before deletion', async () => {
  const remove = vi.fn().mockResolvedValue({ cancelled: true, deleted: [], permanentlyDeleted: [], trashed: [], errors: [] });
  Object.defineProperty(window, 'coworker', { configurable: true, value: {
    platform: 'darwin',
    files: {
      roots: async () => [roots[0]], list: async () => [entry('reports', 'directory')],
      prepareDelete: async () => ({ token: 'folder-confirmation', paths: ['/workspace/reports'], permanentFolders: ['/workspace/reports'] }),
      delete: remove,
    },
    events: { subscribe: () => () => {} },
  } });
  render(<WorkspaceFiles coworkerId="ava" name="Ava" onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Delete reports' }));
  const modal = await screen.findByRole('alertdialog', { name: 'Delete folder permanently?' });
  expect(within(modal).getByText(/cannot be recovered/)).toBeTruthy();
  expect(within(modal).getByText('/workspace/reports')).toBeTruthy();
  expect(remove).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(within(modal).getByRole('button', { name: 'Cancel' }));
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(remove).toHaveBeenCalledWith('ava', 'folder-confirmation', false);
  expect(screen.getByRole('button', { name: 'Delete reports' })).toBeTruthy();
});
