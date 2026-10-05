import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileDeleteConfirmation, FileEntry, FilePreview, FileRef, FileRoot } from '@shared/files';
import { collectFiles, fileKey, type LocatedFile } from '../lib/file-explorer';
import { Icon } from './Icon';
import { ModalPortal } from './ModalPortal';
import { FileDeleteDialog } from './FileDeleteDialog';
import { workspaceContextFiles } from '@shared/workspace-context';

function FolderBranch({ coworkerId, location, label, current, onSelect, revision, detail }: {
  coworkerId: string; location: FileRef; label: string; current: FileRef | null;
  onSelect: (ref: FileRef) => void; revision: number; detail?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const loaded = useRef(false);
  useEffect(() => {
    if (!expanded) return;
    let live = true;
    if (!loaded.current) setLoading(true);
    setError('');
    void window.coworker.files.list(coworkerId, location).then(entries => {
      if (live) { loaded.current = true; setChildren(entries.filter(entry => entry.type === 'directory')); }
    }).catch(error => { if (live) { setChildren([]); setError(error instanceof Error ? error.message : String(error)); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [coworkerId, location.root, location.path, expanded, revision]);
  const active = current && fileKey(current) === fileKey(location);
  return <li>
    <div className={`workspace-tree-row${active ? ' active' : ''}`}>
      <button type="button" className="workspace-tree-toggle" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '▾' : '▸'}</button>
      <button type="button" className="workspace-tree-folder" aria-current={active ? 'location' : undefined} title={detail ?? label} onClick={() => { onSelect(location); setExpanded(true); }}><Icon name="folder" /><span>{label}</span></button>
    </div>
    {expanded && <ul>
      {loading && <li className="workspace-tree-note">Loading…</li>}
      {error && <li className="workspace-tree-note" role="alert">{error}</li>}
      {!loading && !error && !children.length && <li className="workspace-tree-note">No subfolders</li>}
      {children.map(child => <FolderBranch key={child.path} coworkerId={coworkerId} location={{ root: location.root, path: child.path }} label={child.name} current={current} onSelect={onSelect} revision={revision} />)}
    </ul>}
  </li>;
}

export function WorkspaceFiles({ coworkerId, name, initialRoot, onClose }: { coworkerId: string; name: string; initialRoot?: string; onClose: () => void }) {
  const recycle = window.coworker.platform === 'win32' ? 'Recycle Bin' : 'Trash';
  const [roots, setRoots] = useState<FileRoot[]>([]);
  // Undefined waits for the configured default; null is the user's All files view.
  const [location, setLocation] = useState<FileRef | null>();
  const [entries, setEntries] = useState<LocatedFile[]>([]);
  const [selected, setSelected] = useState<FileRef[]>([]);
  const [filter, setFilter] = useState('');
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState<FileDeleteConfirmation | null>(null);
  const pendingDelete = useRef<FileDeleteConfirmation | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const previewGeneration = useRef(0);
  const previewedFile = useRef<FileRef | null>(null);
  const panel = useRef<HTMLElement>(null);
  const refresh = useCallback(async (background = false) => {
    const version = ++generation.current;
    let choosingInitialLocation = false;
    if (!background) {
      previewGeneration.current++; previewedFile.current = null;
      setLoading(true); setWarnings([]); setPreview(null);
    }
    try {
      const nextRoots = await window.coworker.files.roots(coworkerId);
      if (version !== generation.current) return;
      setRoots(nextRoots);
      if (location === undefined) {
        choosingInitialLocation = true;
        const chosenRoot = nextRoots.find(root => root.id === initialRoot || root.path === initialRoot)?.id
          ?? nextRoots.find(root => root.defaultOutput && root.writable)?.id ?? 'workspace';
        setLocation({ root: chosenRoot, path: '.' });
        return;
      }
      if (location && !nextRoots.some(root => root.id === location.root)) { setLocation(null); return; }
      const result = location
        ? { entries: (await window.coworker.files.list(coworkerId, location)).map(entry => ({ ...entry, root: location.root })), warnings: [] }
        : await collectFiles(nextRoots, ref => window.coworker.files.list(coworkerId, ref), () => version !== generation.current);
      if (version !== generation.current) return;
      setEntries(result.entries); setWarnings(result.warnings); setError(null);
      if (previewedFile.current && !result.entries.some(entry => fileKey(entry) === fileKey(previewedFile.current!))) {
        previewGeneration.current++; previewedFile.current = null; setPreview(null);
      }
      setSelected(current => current.filter(ref => result.entries.some(entry => fileKey(entry) === fileKey(ref))));
      if (!background) setRevision(value => value + 1);
    } catch (error) {
      if (version === generation.current) { setEntries([]); setSelected([]); setError(error instanceof Error ? error.message : String(error)); }
    } finally { if (version === generation.current && !choosingInitialLocation) setLoading(false); }
  }, [coworkerId, initialRoot, location]);
  useEffect(() => {
    setSelected([]); setEntries([]); setNotice(''); void refresh();
    const focus = () => { void refresh(true); };
    window.addEventListener('focus', focus);
    const unsubscribe = window.coworker.events.subscribe(event => {
      if (event.type === 'entity.changed' && ['artifacts', 'activity', 'coworkers'].includes(event.entity)) void refresh(true);
    });
    return () => { generation.current++; previewGeneration.current++; unsubscribe(); window.removeEventListener('focus', focus); };
  }, [refresh]);
  useEffect(() => { const listener = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose(); }; window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener); }, [onClose, busy]);
  async function act(action: () => Promise<unknown>) {
    setBusy(true); setError(null); setNotice('');
    try { const result = await action(); if (typeof result === 'string') setNotice(`Saved to ${result}`); await refresh(true); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function show(entry: LocatedFile) {
    if (entry.type === 'directory') { setLocation({ root: entry.root, path: entry.path }); return; }
    const version = ++previewGeneration.current;
    previewedFile.current = { root: entry.root, path: entry.path };
    setError(null); setPreview(null);
    try { const next = await window.coworker.files.preview(coworkerId, { root: entry.root, path: entry.path }); if (previewGeneration.current === version) setPreview(next); }
    catch (error) { if (previewGeneration.current === version) setError(error instanceof Error ? error.message : String(error)); }
  }
  function canDelete(entry: LocatedFile) {
    return entry.type !== 'symlink' && roots.some(root => root.id === entry.root && root.writable)
      && !(entry.root === 'workspace' && workspaceContextFiles.some(file => file.path.toLowerCase() === entry.path.toLowerCase()));
  }
  async function remove(refs: FileRef[]) {
    setBusy(true); setError(null); setNotice('');
    try {
      const confirmation = await window.coworker.files.prepareDelete(coworkerId, refs);
      pendingDelete.current = confirmation;
      setDeleteConfirmation(confirmation);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); setBusy(false); }
  }
  const cancelDeletion = useCallback(() => {
    const confirmation = pendingDelete.current;
    pendingDelete.current = null; setDeleteConfirmation(null); setBusy(false);
    if (confirmation) void window.coworker.files.delete(coworkerId, confirmation.token, false).catch(() => undefined);
  }, [coworkerId]);
  useEffect(() => () => {
    const confirmation = pendingDelete.current;
    if (confirmation) void window.coworker.files.delete(coworkerId, confirmation.token, false).catch(() => undefined);
  }, [coworkerId]);
  async function confirmDeletion() {
    const confirmation = pendingDelete.current;
    if (!confirmation) return;
    try {
      const result = await window.coworker.files.delete(coworkerId, confirmation.token, true);
      if (!result.cancelled) {
        const deleted = new Set(result.deleted.map(fileKey));
        const folders = result.permanentlyDeleted ?? [];
        const removed = (ref: FileRef) => deleted.has(fileKey(ref)) || folders.some(folder => folder.root === ref.root && ref.path.startsWith(`${folder.path}/`));
        setEntries(current => current.filter(entry => !removed(entry)));
        setSelected(current => current.filter(ref => !removed(ref)));
        if (previewedFile.current && removed(previewedFile.current)) {
          previewGeneration.current++; previewedFile.current = null; setPreview(null);
        }
        if (folders.length) setRevision(value => value + 1);
        await refresh(true);
        const trashed = result.trashed ?? result.deleted;
        if (result.deleted.length) setNotice([
          folders.length ? `Permanently deleted ${folders.length} ${folders.length === 1 ? 'folder and all its contents' : 'folders and all their contents'}.` : '',
          trashed.length ? `Moved ${trashed.length} ${trashed.length === 1 ? 'file' : 'files'} to ${recycle}.` : '',
        ].filter(Boolean).join(' '));
        if (result.errors.length) setError(result.errors.map(error => `${error.ref.path}: ${error.message}`).join('\n'));
      }
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { pendingDelete.current = null; setDeleteConfirmation(null); setBusy(false); }
  }
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('button')?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || panel.current?.inert) return;
      const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); previous?.focus(); };
  }, []);
  const rootName = (id: string) => roots.find(root => root.id === id)?.name ?? id;
  const segments = !location || location.path === '.' ? [] : location.path.split('/');
  const visible = entries.filter(entry => `${entry.name} ${entry.path} ${rootName(entry.root)}`.toLowerCase().includes(filter.toLowerCase()));
  return <ModalPortal><div className="workspace-files-backdrop" onClick={() => { if (!busy) onClose(); }}>
    <section ref={panel} inert={deleteConfirmation !== null} className="workspace-files" role="dialog" aria-modal="true" aria-label={`${name} files`} onClick={event => event.stopPropagation()}>
      <header><h2>{name} · Files</h2><button type="button" onClick={onClose} disabled={busy} aria-label="Close files">Close</button></header>
      <div className="workspace-files-toolbar">
        <input aria-label="Filter files" placeholder={location ? 'Filter this folder…' : 'Search all files…'} value={filter} onChange={event => setFilter(event.target.value)} />
        <button type="button" disabled={busy || loading} onClick={() => void refresh()}>Refresh</button>
        <button type="button" disabled={busy || loading || !selected.length} onClick={() => void act(() => window.coworker.files.zip(coworkerId, selected))}>Download ZIP{selected.length ? ` (${selected.length})` : ''}</button>
        <button type="button" className="workspace-delete" disabled={busy || loading || !selected.length || selected.length > 100 || !selected.every(ref => entries.some(entry => fileKey(entry) === fileKey(ref) && canDelete(entry)))} onClick={() => void remove(selected)}>Delete{selected.length ? ` (${selected.length})` : ''}</button>
      </div>
      <div className="workspace-files-status">{error ? <p role="alert">{error}</p> : notice ? <p role="status">{notice}</p> : busy ? <p role="status">{deleteConfirmation ? 'Waiting for confirmation…' : 'Updating files…'}</p> : null}</div>
      {warnings.length > 0 && <p role="status">Some files could not be listed. {warnings.slice(0, 3).join(' ')}</p>}
      <div className="workspace-explorer-layout">
        <nav className="workspace-folder-tree" aria-label="Folders">
          <button type="button" className={`workspace-all-files${location === null ? ' active' : ''}`} aria-current={location === null ? 'page' : undefined} onClick={() => setLocation(null)}><Icon name="file" />All files</button>
          <small className="workspace-tree-heading">Locations</small>
          <ul>{roots.map(root => <FolderBranch key={root.id} coworkerId={coworkerId} location={{ root: root.id, path: '.' }} label={root.name} detail={`${root.path}${root.writable ? '' : ' · Read-only'}${root.defaultOutput ? ' · Default output' : ''}`} current={location ?? null} onSelect={setLocation} revision={revision} />)}</ul>
        </nav>
        <div className="workspace-files-content" aria-busy={loading}>
          <nav className="workspace-breadcrumbs" aria-label="Folder breadcrumbs">{location ? <><button type="button" onClick={() => setLocation({ root: location.root, path: '.' })}>{rootName(location.root)}</button>{segments.map((segment, index) => <span key={index}> / <button type="button" onClick={() => setLocation({ root: location.root, path: segments.slice(0, index + 1).join('/') })}>{segment}</button></span>)}</> : <strong>All files</strong>}</nav>
          {loading ? <p role="status">{location ? 'Loading files…' : 'Finding files across all locations…'}</p> : <div className="workspace-file-list">
            {!visible.length && <p>{filter ? 'No files match your search.' : location ? 'This folder is empty.' : 'No files in the workspace or granted folders.'}</p>}
            {visible.map(entry => {
              const ref = { root: entry.root, path: entry.path };
              return <div className="workspace-file-row" key={fileKey(entry)}>
                <input type="checkbox" aria-label={`Select ${entry.name}`} checked={selected.some(value => fileKey(value) === fileKey(ref))} disabled={busy || entry.type === 'symlink'} onChange={event => setSelected(current => event.target.checked ? [...current, ref] : current.filter(value => fileKey(value) !== fileKey(ref)))} />
                <Icon name={entry.type === 'directory' ? 'folder' : 'file'} />
                <button type="button" className="workspace-file-name" disabled={entry.type === 'symlink'} onClick={() => void show(entry)}>{entry.name}<small>{!location ? `${rootName(entry.root)} / ${entry.path} · ` : ''}{entry.type === 'directory' ? 'Folder' : `${entry.size.toLocaleString()} bytes`}</small></button>
                <button type="button" disabled={busy || entry.type === 'symlink'} onClick={() => void act(() => window.coworker.files.open(coworkerId, ref))}>Open</button>
                <button type="button" disabled={busy || entry.type === 'symlink'} onClick={() => void act(() => window.coworker.files.reveal(coworkerId, ref))}>Reveal</button>
                {entry.type === 'file' && <button type="button" disabled={busy} onClick={() => void act(() => window.coworker.files.download(coworkerId, ref))}>Download</button>}
                {entry.type !== 'symlink' && <button type="button" className="workspace-delete" title={canDelete(entry) ? (entry.type === 'directory' ? 'Permanently delete folder and all contents' : `Move file to ${recycle}`) : 'Write access is required; managed memory files are protected'} aria-label={`Delete ${entry.name}`} disabled={busy || !canDelete(entry)} onClick={() => void remove([ref])}><Icon name="trash" /></button>}
              </div>;
            })}
          </div>}
          {preview && <aside className="workspace-file-preview"><h3>{preview.name}</h3>{preview.kind === 'image' ? <img src={preview.content} alt={preview.name} /> : <pre>{preview.content}</pre>}{preview.truncated && <p>Preview truncated.</p>}</aside>}
        </div>
      </div>
    </section>
  </div>{deleteConfirmation && <FileDeleteDialog confirmation={deleteConfirmation} onCancel={cancelDeletion} onConfirm={confirmDeletion} />}</ModalPortal>;
}
