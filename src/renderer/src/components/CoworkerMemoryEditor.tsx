import { useEffect, useState } from "react";
import { memoryFile, type WorkspaceTextDocument } from "@shared/workspace-context";

export function CoworkerMemoryEditor({ coworkerId, name, disabled = false, onDirtyChange }: {
  coworkerId: string;
  name: string;
  disabled?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [saved, setSaved] = useState<WorkspaceTextDocument | null>(null);
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const dirty = Boolean(saved && content !== saved.content);

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);
    setNotice(null);
    void window.coworker.memory.read(coworkerId).then((document) => {
      if (cancelled) return;
      setSaved(document);
      setContent(document.content);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [coworkerId, reload]);

  async function saveMemory() {
    if (!saved) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const document = await window.coworker.memory.update(coworkerId, { content, expectedRevision: saved.revision });
      setSaved(document);
      setContent(document.content);
      setNotice("Memory saved. It will be loaded on the next turn.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  }

  return (
    <fieldset className="form-stack">
      <legend>Memory</legend>
      <small>Facts and preferences saved for {name}, across conversations. Saved separately from other settings. Clear the text and save to forget all saved memory.</small>
      <label>
        <span>Saved memory (Markdown)</span>
        <textarea
          value={content}
          disabled={disabled || busy || !saved}
          rows={7}
          maxLength={memoryFile.maxCharacters}
          onChange={(event) => { setContent(event.target.value); setNotice(null); }}
        />
      </label>
      <small>{content.length.toLocaleString()} / {memoryFile.maxCharacters.toLocaleString()} characters</small>
      {error ? <div className="inline-error" role="alert">{error} Your unsaved text is kept; copy it before reloading.</div> : null}
      {notice ? <small role="status">{notice}</small> : null}
      <div className="modal-actions">
        <button className="secondary-button" type="button" disabled={disabled || busy} onClick={() => setReload((value) => value + 1)}>Reload memory</button>
        <button className="primary-button" type="button" disabled={disabled || busy || !saved || !dirty || content.length > memoryFile.maxCharacters} onClick={() => void saveMemory()}>
          {busy ? "Loading / saving memory…" : "Save memory"}
        </button>
      </div>
    </fieldset>
  );
}
