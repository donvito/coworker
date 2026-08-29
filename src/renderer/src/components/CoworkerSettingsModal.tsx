import { useState, type FormEvent } from "react";
import type { Coworker, ModelEndpoint, RemoteModelProvider, Skill } from "@shared/contracts";
import { Icon } from "./Icon";
import { ModalPortal } from "./ModalPortal";
import { ModelSelector } from "./ModelSelector";
import { ProviderSelect } from "./ProviderSelect";

function folderDisplayName(path: string): string {
  const segments = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return segments.at(-1) || path;
}

export function revealFolderLabel(platform: string): string {
  if (platform === "darwin") return "Reveal in Finder";
  if (platform === "win32") return "Show in Explorer";
  return "Open folder";
}

export function CoworkerSettingsModal({
  coworker,
  skills,
  modelEndpoints = [],
  onClose,
  onChanged,
  onRemoved,
  onOpenModelSettings,
}: {
  coworker: Coworker;
  skills: Skill[];
  modelEndpoints?: ModelEndpoint[];
  onClose: () => void;
  onChanged: () => Promise<void>;
  onRemoved: () => void;
  onOpenModelSettings?: () => void;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<RemoteModelProvider | "">(
    coworker.modelProvider === "demo" ? "" : coworker.modelProvider,
  );
  const [modelName, setModelName] = useState(
    coworker.modelProvider === "demo" ? "" : coworker.modelName,
  );
  const [enabledSkillIds, setEnabledSkillIds] = useState(coworker.enabledSkillIds);
  const [sharedFolderPaths, setSharedFolderPaths] = useState(
    coworker.sharedFolders.map((folder) => folder.path),
  );
  const savedFolderPaths = new Set(coworker.sharedFolders.map((folder) => folder.path));

  async function addSharedFolders() {
    setError(null);
    try {
      const picked = await window.coworker.folders.pick();
      if (picked.length === 0) return;
      setSharedFolderPaths((current) => [...new Set([...current, ...picked])]);
    } catch (pickError) {
      setError(pickError instanceof Error ? pickError.message : String(pickError));
    }
  }

  async function revealSharedFolder(path: string) {
    setError(null);
    try {
      await window.coworker.folders.reveal(coworker.id, path);
    } catch (revealError) {
      setError(revealError instanceof Error ? revealError.message : String(revealError));
    }
  }

  async function clearBrowserProfile() {
    if (
      !confirm(
        `Clear ${coworker.name}’s browser cookies, logins, history, and site data? This cannot be undone.`,
      )
    ) {
      return;
    }
    setWorking(true);
    setError(null);
    try {
      await window.coworker.browser.clearProfile(coworker.id);
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : String(clearError));
    } finally {
      setWorking(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setWorking(true);
    setError(null);
    try {
      // A model is required before the coworker can run, but every other
      // setting (folders, skills, instructions) stays saveable without one.
      const modelPatch =
        provider && modelName ? { modelProvider: provider, modelName } : {};
      await window.coworker.coworkers.update(coworker.id, {
        name: String(data.get("name") ?? "").trim(),
        role: String(data.get("role") ?? "").trim(),
        description: String(data.get("description") ?? "").trim() || null,
        systemPrompt: String(data.get("systemPrompt") ?? "").trim(),
        status: String(data.get("status")) as Coworker["status"],
        enabledSkillIds,
        sharedFolderPaths,
        ...modelPatch,
      });
      await onChanged();
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setWorking(false);
    }
  }

  async function remove() {
    if (!confirm(`Remove ${coworker.name} and their local history?`)) return;
    setWorking(true);
    setError(null);
    try {
      await window.coworker.coworkers.remove(coworker.id);
      await onChanged();
      onRemoved();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError));
      setWorking(false);
    }
  }

  return (
    <ModalPortal>
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        aria-labelledby="coworker-settings-title"
        aria-modal="true"
        className="modal-card coworker-settings-modal"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <span className="eyebrow">Coworker configuration</span>
        <h2 id="coworker-settings-title">Manage {coworker.name}</h2>
        <p>Changes restart this coworker’s isolated runtime. Queued work remains durable.</p>
        <form className="form-stack" onSubmit={save}>
          <div className="form-split">
            <label>
              <span>Name</span>
              <input defaultValue={coworker.name} maxLength={80} name="name" required />
            </label>
            <label>
              <span>Role</span>
              <input defaultValue={coworker.role} maxLength={120} name="role" required />
            </label>
          </div>
          <label>
            <span>Description</span>
            <textarea defaultValue={coworker.description ?? ""} maxLength={10_000} name="description" rows={2} />
          </label>
          <fieldset className="skill-picker">
            <legend>Skills</legend>
            <small>Installed skills are global; choose which ones this coworker can use.</small>
            {skills.map((skill) => (
              <label key={skill.id}>
                <input
                  checked={enabledSkillIds.includes(skill.id)}
                  disabled={working}
                  onChange={(event) =>
                    setEnabledSkillIds((current) =>
                      event.target.checked
                        ? [...current, skill.id]
                        : current.filter((id) => id !== skill.id),
                    )
                  }
                  type="checkbox"
                />
                <span>
                  <strong>{skill.name}</strong>
                  <small>{skill.description}</small>
                </span>
              </label>
            ))}
          </fieldset>
          {skills.some(
            (skill) =>
              skill.name === "browser-control" && enabledSkillIds.includes(skill.id),
          ) ? (
            <fieldset className="folder-picker">
              <legend>Browser data</legend>
              <small>
                This coworker keeps an isolated browser profile for website logins and cookies.
                Clearing it also closes the controlled browser.
              </small>
              <button
                className="secondary-button"
                disabled={working}
                onClick={() => void clearBrowserProfile()}
                type="button"
              >
                Clear browser data…
              </button>
            </fieldset>
          ) : null}
          <fieldset className="folder-picker">
            <legend>Folder access</legend>
            <small>
              Read-only folders on this computer that {coworker.name} can browse and read.
              Coworkers can never create, change, or delete anything in them.
            </small>
            {sharedFolderPaths.length === 0 ? (
              <p className="folder-picker-empty">No folders granted yet.</p>
            ) : (
              <ul className="folder-picker-list">
                {sharedFolderPaths.map((path) => {
                  const saved = savedFolderPaths.has(path);
                  const alias = coworker.sharedFolders.find(
                    (folder) => folder.path === path,
                  )?.alias;
                  return (
                    <li key={path}>
                      <Icon name="file" />
                      <span className="folder-picker-name">
                        <strong>{alias ?? folderDisplayName(path)}</strong>
                        <small title={path}>{path}</small>
                      </span>
                      {saved ? (
                        <button
                          className="text-button"
                          disabled={working}
                          onClick={() => void revealSharedFolder(path)}
                          type="button"
                        >
                          {revealFolderLabel(window.coworker.platform)}
                        </button>
                      ) : (
                        <small className="folder-picker-pending">Added on save</small>
                      )}
                      <button
                        aria-label={`Remove folder ${path}`}
                        className="ghost-button danger"
                        disabled={working}
                        onClick={() =>
                          setSharedFolderPaths((current) =>
                            current.filter((candidate) => candidate !== path),
                          )
                        }
                        type="button"
                      >
                        Remove
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <button
              className="secondary-button"
              disabled={working}
              onClick={() => void addSharedFolders()}
              type="button"
            >
              Add folder…
            </button>
          </fieldset>
          <label>
            <span>Operating instructions</span>
            <textarea defaultValue={coworker.systemPrompt} name="systemPrompt" required rows={5} />
            <small>
              Combined with Settings → General → Global operating instructions and built-in tool
              safeguards.
            </small>
          </label>
          <ProviderSelect
            disabled={working}
            emptyLabel="No model configured"
            modelEndpoints={modelEndpoints}
            onChange={(next) => {
              setProvider(next);
              setModelName("");
            }}
            value={provider}
          />
          {provider ? (
            <ModelSelector
              disabled={working}
              onChange={setModelName}
              provider={provider}
              value={modelName}
            />
          ) : (
            <div className="model-not-configured">
              <strong>No model configured</strong>
              <small>
                {coworker.name} needs a model before it can work. Other settings still save.
              </small>
              {onOpenModelSettings ? (
                <button
                  className="text-button"
                  onClick={onOpenModelSettings}
                  type="button"
                >
                  Open model settings
                </button>
              ) : (
                <small>Add an API key in Settings → Models, then choose its provider here.</small>
              )}
            </div>
          )}
          <label>
            <span>Availability</span>
            <select defaultValue={coworker.status} name="status">
              <option value="active">Active</option>
              <option value="paused">Paused — keep queued work waiting</option>
            </select>
          </label>
          {error ? <div className="inline-error">{error}</div> : null}
          <div className="modal-actions split-actions">
            <button className="ghost-button danger" disabled={working} onClick={() => void remove()} type="button">
              Remove coworker
            </button>
            <span>
              <button className="secondary-button" disabled={working} onClick={onClose} type="button">
                Cancel
              </button>
              <button className="primary-button" disabled={working}>
                {working ? "Saving…" : "Save changes"}
              </button>
            </span>
          </div>
        </form>
      </section>
    </div>
    </ModalPortal>
  );
}
