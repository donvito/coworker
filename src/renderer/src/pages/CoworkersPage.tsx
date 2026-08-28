import { useState, type FormEvent } from "react";
import type {
  AppSettings,
  Coworker,
  Integration,
  ModelEndpoint,
  RemoteModelProvider,
} from "@shared/contracts";
import { Icon } from "../components/Icon";
import { ModalPortal } from "../components/ModalPortal";
import { ModelSelector } from "../components/ModelSelector";
import { ProviderSelect } from "../components/ProviderSelect";
import {
  CoworkerAvatar,
  CoworkerModelBadge,
  PageHeader,
  StatusLabel,
  TelegramLinkBadge,
  coworkerAvatarCount,
  coworkerAvatarVisual,
  telegramLinkedCoworkerId,
} from "../components/Primitives";

type CoworkerView = "cards" | "list";

export function CoworkersPage({
  coworkers,
  settings,
  modelEndpoints = [],
  integrations = [],
  onOpen,
  onChanged,
  onOpenModelSettings,
}: {
  coworkers: Coworker[];
  settings: AppSettings;
  modelEndpoints?: ModelEndpoint[];
  integrations?: Integration[];
  onOpen: (coworker: Coworker) => void;
  onChanged: () => Promise<void>;
  onOpenModelSettings?: () => void;
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
            <CoworkerAvatar className="large-avatar" coworker={coworker} />
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
              <CoworkerModelBadge coworker={coworker} modelEndpoints={modelEndpoints} />
              {telegramLinkedCoworkerId(integrations) === coworker.id ? (
                <TelegramLinkBadge />
              ) : null}
            </span>
            <span className="roster-open-cta">
              <span>Open workspace</span>
              <Icon name="arrow" />
            </span>
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
          settings={settings}
          modelEndpoints={modelEndpoints}
          onChanged={onChanged}
          onClose={() => setCreating(false)}
          onCreated={onOpen}
          onOpenModelSettings={onOpenModelSettings}
        />
      ) : null}
    </div>
  );
}

export function CreateCoworkerModal({
  settings,
  modelEndpoints = [],
  onChanged,
  onClose,
  onCreated,
  onOpenModelSettings,
}: {
  settings: Pick<AppSettings, "defaultModelProvider" | "defaultModelName">;
  modelEndpoints?: ModelEndpoint[];
  onChanged: () => Promise<void>;
  onClose: () => void;
  onCreated: (coworker: Coworker) => void;
  onOpenModelSettings?: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<RemoteModelProvider | "">(
    settings.defaultModelProvider ?? "",
  );
  const [modelName, setModelName] = useState(settings.defaultModelName ?? "");
  const [avatarChoice, setAvatarChoice] = useState(() =>
    Math.floor(Math.random() * coworkerAvatarCount),
  );

  async function createCoworker(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    const role = String(data.get("role") ?? "").trim();
    if (!provider || !modelName) {
      setError("No model configured. Add an API key and choose a default model in Settings.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const coworker = await window.coworker.coworkers.create({
        name,
        role,
        avatarIndex: avatarChoice,
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
          "schedules.create",
          "email.send",
        ],
        policies: { "email.send": "approval", "schedules.create": "approval" },
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
    <ModalPortal>
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal-card create-coworker-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-coworker-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="eyebrow">New desk</span>
        <h2 id="create-coworker-title">Create a coworker</h2>
        <p>Start with a clear responsibility. Tools remain controlled by the app.</p>
        <form onSubmit={createCoworker} className="form-stack">
          <div className="avatar-picker">
            <span>Avatar</span>
            <div className="avatar-picker-grid" role="radiogroup" aria-label="Coworker avatar">
              {Array.from({ length: coworkerAvatarCount }, (_, index) => {
                const visual = coworkerAvatarVisual(index);
                return (
                  <button
                    aria-checked={index === avatarChoice}
                    aria-label={`Avatar ${index + 1}`}
                    className={
                      index === avatarChoice ? "avatar-option selected" : "avatar-option"
                    }
                    key={index}
                    onClick={() => setAvatarChoice(index)}
                    role="radio"
                    style={{ backgroundColor: visual.color }}
                    type="button"
                  >
                    <img alt="" src={visual.image} />
                  </button>
                );
              })}
            </div>
          </div>
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
          {provider ? (
            <>
              <ProviderSelect
                disabled={saving}
                modelEndpoints={modelEndpoints}
                onChange={(next) => {
                  setProvider(next);
                  setModelName("");
                }}
                value={provider}
              />
              <ModelSelector
                disabled={saving}
                onChange={setModelName}
                provider={provider}
                value={modelName}
              />
            </>
          ) : (
            <div className="model-not-configured create-coworker-model-empty">
              <strong>No model configured</strong>
              <small>Add an API key and select a default model in Settings before creating a coworker.</small>
              {onOpenModelSettings ? (
                <button className="text-button" onClick={onOpenModelSettings} type="button">
                  Open model settings
                </button>
              ) : null}
            </div>
          )}
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
    </ModalPortal>
  );
}
