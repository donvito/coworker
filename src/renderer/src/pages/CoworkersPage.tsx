import { useState, type FormEvent } from "react";
import type { Coworker, ModelProvider } from "@shared/contracts";
import { Icon } from "../components/Icon";
import { ModelSelector } from "../components/ModelSelector";
import { PageHeader, StatusLabel, initials } from "../components/Primitives";

type CoworkerView = "cards" | "list";

export function CoworkersPage({
  coworkers,
  onOpen,
  onChanged,
}: {
  coworkers: Coworker[];
  onOpen: (coworker: Coworker) => void;
  onChanged: () => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [view, setView] = useState<CoworkerView>(() =>
    window.localStorage.getItem("coworker-directory-view") === "list" ? "list" : "cards",
  );

  function changeView(nextView: CoworkerView) {
    setView(nextView);
    window.localStorage.setItem("coworker-directory-view", nextView);
  }

  return (
    <div className="page coworkers-page">
      <PageHeader
        eyebrow="Team"
        title="Coworkers"
        description="Each coworker has an independent runtime, workspace, and one focused task queue."
        action={
          <div className="coworker-header-actions">
            <div className="directory-view-switch" role="group" aria-label="Coworker view">
              <button
                aria-pressed={view === "cards"}
                className={view === "cards" ? "active" : ""}
                onClick={() => changeView("cards")}
                title="Card view"
                type="button"
              >
                <Icon name="grid" />
                Cards
              </button>
              <button
                aria-pressed={view === "list"}
                className={view === "list" ? "active" : ""}
                onClick={() => changeView("list")}
                title="Compact list view"
                type="button"
              >
                <Icon name="list" />
                List
              </button>
            </div>
            <button className="primary-button" onClick={() => setCreating(true)}>
              <Icon name="plus" /> Create coworker
            </button>
          </div>
        }
      />

      <div className="coworker-directory-head">
        <span>
          {coworkers.length} coworker{coworkers.length === 1 ? "" : "s"}
        </span>
        <small>
          {view === "cards" ? "Workspace cards" : "Compact directory"}
        </small>
      </div>

      <div className={`coworker-roster ${view}`}>
        {coworkers.map((coworker) => (
          <button className="roster-card" key={coworker.id} onClick={() => onOpen(coworker)}>
            <span className="large-avatar">{initials(coworker.name)}</span>
            <span className="roster-copy">
              <span className="roster-name">
                <strong>{coworker.name}</strong>
                <StatusLabel status={coworker.runtimeStatus} />
              </span>
              <h3>{coworker.role}</h3>
              <p>{coworker.description || "Ready to take on a focused responsibility."}</p>
            </span>
            <span className="roster-meta">
              <span>
                <Icon name="settings" />
                {coworker.enabledTools.length} tools
              </span>
              <small>
                {coworker.modelProvider} · {coworker.modelName}
              </small>
            </span>
            <Icon name="arrow" className="roster-arrow" />
          </button>
        ))}
        {coworkers.length === 0 ? (
          <div className="coworker-directory-empty">
            <span className="empty-icon">
              <Icon name="people" />
            </span>
            <h3>Your team is empty</h3>
            <p>Create a coworker with a focused role and controlled tools.</p>
            <button className="primary-button" onClick={() => setCreating(true)}>
              <Icon name="plus" /> Create coworker
            </button>
          </div>
        ) : null}
      </div>

      {creating ? (
        <CreateCoworkerModal
          onChanged={onChanged}
          onClose={() => setCreating(false)}
          onCreated={onOpen}
        />
      ) : null}
    </div>
  );
}

export function CreateCoworkerModal({
  onChanged,
  onClose,
  onCreated,
}: {
  onChanged: () => Promise<void>;
  onClose: () => void;
  onCreated: (coworker: Coworker) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<ModelProvider>("demo");
  const [modelName, setModelName] = useState("faux-1");

  async function createCoworker(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    const role = String(data.get("role") ?? "").trim();
    setSaving(true);
    setError(null);
    try {
      const coworker = await window.coworker.coworkers.create({
        name,
        role,
        description: String(data.get("description") ?? "").trim(),
        systemPrompt: `You are ${name}, a ${role}. Work carefully, use only the tools provided, and never claim an external action succeeded unless its tool confirms success.`,
        modelProvider: provider,
        modelName,
        enabledTools: [
          "files.list",
          "files.read",
          "files.write",
          "documents.export",
          "email.create_draft",
          "email.send",
        ],
        policies: { "email.send": "approval" },
      });
      onClose();
      await onChanged();
      onCreated(coworker);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-coworker-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="eyebrow">New desk</span>
        <h2 id="create-coworker-title">Create a coworker</h2>
        <p>Start with a clear responsibility. Tools remain controlled by the app.</p>
        <form onSubmit={createCoworker} className="form-stack">
          <label>
            <span>Name</span>
            <input name="name" placeholder="e.g. Mia" required maxLength={80} autoFocus />
          </label>
          <label>
            <span>Role</span>
            <input name="role" placeholder="e.g. Support Coworker" required maxLength={120} />
          </label>
          <label>
            <span>What should they own?</span>
            <textarea
              name="description"
              placeholder="Triage customer questions and prepare clear replies."
              rows={3}
              maxLength={1000}
            />
          </label>
          <div className="form-split">
            <label>
              <span>Model provider</span>
              <select
                disabled={saving}
                name="provider"
                onChange={(event) => {
                  const nextProvider = event.target.value as ModelProvider;
                  setProvider(nextProvider);
                  setModelName(nextProvider === "demo" ? "faux-1" : "");
                }}
                value={provider}
              >
                <option value="demo">Built-in demo</option>
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
                <option value="google">Google</option>
              </select>
            </label>
            <ModelSelector
              disabled={saving}
              onChange={setModelName}
              provider={provider}
              value={modelName}
            />
          </div>
          {error ? <div className="inline-error">{error}</div> : null}
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary-button" disabled={saving || !modelName}>
              {saving ? "Creating…" : "Create coworker"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
