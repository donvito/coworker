import { useEffect, useId, useRef, useState } from 'react';
import type { FileDeleteConfirmation } from '@shared/files';
import { Icon } from './Icon';

export function FileDeleteDialog({ confirmation, onCancel, onConfirm }: {
  confirmation: FileDeleteConfirmation; onCancel: () => void; onConfirm: () => Promise<void>;
}) {
  const titleId = useId(), descriptionId = useId();
  const dialog = useRef<HTMLElement>(null);
  const [working, setWorking] = useState(false);
  const folders = confirmation.permanentFolders;
  const files = confirmation.paths.filter(path => !folders.includes(path));
  const recycle = window.coworker.platform === 'win32' ? 'Recycle Bin' : 'Trash';
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); if (!working) onCancel(); }
      if (event.key === 'Tab') {
        const buttons = [...(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        if (!buttons.length) { event.preventDefault(); return; }
        if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => { document.removeEventListener('keydown', keydown, true); if (previous?.isConnected) previous.focus(); };
  }, [onCancel, working]);
  function items(paths: string[]) {
    return <ul className="file-delete-items">{paths.map(path => <li key={path}>
      <Icon name={folders.includes(path) ? 'folder' : 'file'} />
      <span><strong>{path.replaceAll('\\', '/').split('/').at(-1)}</strong><small>{path}</small></span>
    </li>)}</ul>;
  }
  return <div className="file-delete-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !working) onCancel(); }}>
    <section ref={dialog} className="file-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
      <h2 id={titleId}>{folders.length ? `Delete ${folders.length === 1 ? 'folder' : `${folders.length} folders`} permanently?` : `Move ${files.length === 1 ? 'file' : `${files.length} files`} to ${recycle}?`}</h2>
      <p id={descriptionId} className={folders.length ? 'file-delete-warning' : ''}>{folders.length
        ? 'All files and subfolders inside will be permanently deleted and cannot be recovered.'
        : `You can restore ${files.length === 1 ? 'this file' : 'these files'} from ${recycle}.`}</p>
      {folders.length > 0 && items(folders)}
      {folders.length > 0 && files.length > 0 && <p>These separate files will be moved to {recycle}:</p>}
      {files.length > 0 && items(files)}
      <footer>
        <button type="button" className="secondary-button" disabled={working} onClick={onCancel}>Cancel</button>
        <button type="button" className="secondary-button destructive-button" disabled={working} onClick={() => { setWorking(true); void onConfirm(); }}>{working ? 'Deleting…' : folders.length ? 'Delete permanently' : `Move to ${recycle}`}</button>
      </footer>
    </section>
  </div>;
}
