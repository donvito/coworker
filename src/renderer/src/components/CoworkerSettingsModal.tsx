import { useState, type FormEvent } from "react";
import type { Coworker, RemoteModelProvider, Skill } from "@shared/contracts";
import { remoteModelProviderDefinitions } from "@shared/model-providers";
import { ModelSelector } from "./ModelSelector";

export function CoworkerSettingsModal({
  coworker,
  skills,
  onClose,
  onChanged,
  onRemoved,
}: {
  coworker: Coworker;
  skills: Skill[];
  onClose: () => void;
  onChanged: () => Promise<void>;
  onRemoved: () => void;
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

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (!provider || !modelName) {
      setError("No model configured. Add an API key and choose a default model in Settings.");
      return;
    }
    setWorking(true);
    setError(null);
    try {
      await window.coworker.coworkers.update(coworker.id, {
        name: String(data.get("name") ?? "").trim(),
        role: String(data.get("role") ?? "").trim(),
        description: String(data.get("description") ?? "").trim() || null,
        systemPrompt: String(data.get("systemPrompt") ?? "").trim(),
        modelProvider: provider,
        modelName,
        status: String(data.get("status")) as Coworker["status"],
        enabledSkillIds,
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
          <label>
            <span>Operating instructions</span>
            <textarea defaultValue={coworker.systemPrompt} name="systemPrompt" required rows={5} />
          </label>
          <div className="form-split">
            <label>
              <span>Model provider</span>
              <select
                disabled={working}
                name="modelProvider"
                onChange={(event) => {
                  setProvider(event.target.value as RemoteModelProvider | "");
                  setModelName("");
                }}
                value={provider}
              >
                <option value="">No model configured</option>
                {remoteModelProviderDefinitions.map((definition) => (
                  <option key={definition.id} value={definition.id}>
                    {definition.label}
                  </option>
                ))}
              </select>
            </label>
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
                <small>Add an API key in Settings, then choose its provider here.</small>
              </div>
            )}
          </div>
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
              <button className="primary-button" disabled={working || !modelName}>
                {working ? "Saving…" : "Save changes"}
              </button>
            </span>
          </div>
        </form>
      </section>
    </div>
  );
}
