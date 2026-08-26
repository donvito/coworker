import { useEffect, useState, type FormEvent } from "react";
import type {
  AppSettings,
  AppTheme,
  Coworker,
  Integration,
  ProviderErrorDiagnostic,
  RemoteModelProvider,
  Skill,
  WebSearchProvider,
} from "@shared/contracts";
import { webSearchProviders } from "@shared/contracts";
import {
  getModelProviderDefinition,
  modelProviderBaseUrlKey,
  modelProviderCredentialKey,
  modelProviderName,
  remoteModelProviderDefinitions,
} from "@shared/model-providers";
import { Icon } from "../components/Icon";
import { ModelSelector } from "../components/ModelSelector";
import { PageHeader } from "../components/Primitives";
import { readableError } from "../lib/errors";

export type SettingsTab = "general" | "models" | "skills" | "integrations" | "data";

const themeOptions: Array<{ id: AppTheme; label: string; description: string }> = [
  { id: "graphite", label: "Graphite", description: "Neutral monochrome, the default" },
  { id: "forest", label: "Forest", description: "Deep green" },
  { id: "ocean", label: "Ocean", description: "Calm navy blue" },
  { id: "plum", label: "Plum", description: "Muted violet" },
  { id: "clay", label: "Clay", description: "Warm terracotta" },
];

function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

export function SettingsPage({
  settings,
  integrations,
  skills,
  coworkers,
  dataPath,
  version = "development",
  initialTab = "general",
  onChanged,
}: {
  settings: AppSettings;
  integrations: Integration[];
  skills: Skill[];
  coworkers: Coworker[];
  dataPath: string;
  version?: string;
  initialTab?: SettingsTab;
  onChanged: () => Promise<void>;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeKind, setNoticeKind] = useState<"success" | "error">("success");
  const [credentialStatus, setCredentialStatus] = useState<Record<string, boolean>>({});
  const [unreadableKeys, setUnreadableKeys] = useState<string[]>([]);
  const [credentialsLoaded, setCredentialsLoaded] = useState(false);
  const [modelProvider, setModelProvider] = useState<RemoteModelProvider>("anthropic");
  const [makeDefaultModel, setMakeDefaultModel] = useState(true);
  const [defaultModelChoice, setDefaultModelChoice] = useState("");
  const [webSearchProvider, setWebSearchProvider] = useState<WebSearchProvider>("tavily");
  const [providerErrors, setProviderErrors] = useState<ProviderErrorDiagnostic[]>([]);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [globalInstructions, setGlobalInstructions] = useState(
    settings.globalOperatingInstructions,
  );

  useEffect(() => {
    const keys = [
      ...remoteModelProviderDefinitions.flatMap((provider) =>
        getModelProviderDefinition(provider.id).baseUrlMode === "none"
          ? [modelProviderCredentialKey(provider.id)]
          : [
              modelProviderCredentialKey(provider.id),
              modelProviderBaseUrlKey(provider.id),
            ],
      ),
      "integration:email:resend",
      ...webSearchProviders.map((provider) => `web-search:${provider}`),
    ];
    void Promise.all(
      keys.map(
        async (key) =>
          [key, await window.coworker.integrations.credentialStatus(key)] as const,
      ),
    )
      .then((entries) => {
        setCredentialStatus(
          Object.fromEntries(entries.map(([key, status]) => [key, status.configured])),
        );
        setUnreadableKeys(
          entries.filter(([, status]) => status.needsReentry).map(([key]) => key),
        );
      })
      .catch((loadError) => {
        setNoticeKind("error");
        setNotice(
          `Could not check configured providers: ${
            loadError instanceof Error ? loadError.message : String(loadError)
          }`,
        );
      })
      .finally(() => setCredentialsLoaded(true));
  }, [integrations]);

  useEffect(() => {
    const providerIsDefault = settings.defaultModelProvider === modelProvider;
    setMakeDefaultModel(providerIsDefault || !settings.defaultModelProvider);
    setDefaultModelChoice(providerIsDefault ? settings.defaultModelName ?? "" : "");
  }, [modelProvider, settings.defaultModelName, settings.defaultModelProvider]);

  useEffect(() => {
    setGlobalInstructions(settings.globalOperatingInstructions);
  }, [settings.globalOperatingInstructions]);

  useEffect(() => {
    if (tab === "data") void refreshProviderErrors();
  }, [tab]);

  async function refreshProviderErrors() {
    setDiagnosticsLoading(true);
    try {
      setProviderErrors(await window.coworker.diagnostics.listProviderErrors(50));
    } catch (loadError) {
      setNoticeKind("error");
      setNotice(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setDiagnosticsLoading(false);
    }
  }

  async function copyProviderReport() {
    try {
      const result = await window.coworker.diagnostics.copyProviderReport();
      setNoticeKind("success");
      setNotice(
        result.count > 0
          ? `Copied a redacted report with ${result.count} provider error${result.count === 1 ? "" : "s"}.`
          : "Copied an empty provider report.",
      );
    } catch (copyError) {
      setNoticeKind("error");
      setNotice(copyError instanceof Error ? copyError.message : String(copyError));
    }
  }

  async function exportSupportBundle() {
    try {
      const path = await window.coworker.diagnostics.exportSupportBundle();
      if (!path) return;
      setNoticeKind("success");
      setNotice(`Diagnostics ZIP saved to ${path}`);
    } catch (exportError) {
      setNoticeKind("error");
      setNotice(exportError instanceof Error ? exportError.message : String(exportError));
    }
  }

  async function exportDataBackup() {
    try {
      const path = await window.coworker.app.exportDataBackup();
      if (!path) return;
      setNoticeKind("success");
      setNotice(`Complete data backup saved to ${path}`);
    } catch (exportError) {
      setNoticeKind("error");
      setNotice(exportError instanceof Error ? exportError.message : String(exportError));
    }
  }

  async function patchSettings(patch: Partial<AppSettings>) {
    setWorking(true);
    try {
      await window.coworker.app.updateSettings(patch);
      await onChanged();
    } finally {
      setWorking(false);
    }
  }

  async function saveGlobalInstructions(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setWorking(true);
    setNotice(null);
    try {
      await window.coworker.app.updateSettings({
        globalOperatingInstructions: globalInstructions.trim(),
      });
      await onChanged();
      setNoticeKind("success");
      setNotice(
        "Global operating instructions saved. Coworkers will use them on the next request.",
      );
    } catch (saveError) {
      setNoticeKind("error");
      setNotice(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setWorking(false);
    }
  }

  async function configureModel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const provider = modelProvider;
    const apiKey = String(data.get("apiKey") ?? "").trim();
    const baseUrl = String(data.get("baseUrl") ?? "").trim();
    setWorking(true);
    setNotice(null);
    try {
      const result = await window.coworker.integrations.configureModel({
        provider,
        apiKey: apiKey || undefined,
        baseUrl: baseUrl || undefined,
        defaultModelName:
          makeDefaultModel && defaultModelChoice ? defaultModelChoice : undefined,
      });
      setCredentialStatus((current) => ({ ...current, [result.key]: true }));
      let appliedDefault = result.defaultApplied ? defaultModelChoice : "";
      if (makeDefaultModel && !result.defaultApplied && result.models[0]) {
        // First-time connection: the model list only became known during this
        // save, so apply the first available model and let the user adjust it.
        appliedDefault = result.models[0].id;
        await window.coworker.app.updateSettings({
          defaultModelProvider: provider,
          defaultModelName: appliedDefault,
        });
        setDefaultModelChoice(appliedDefault);
      }
      await onChanged();
      form.reset();
      setNoticeKind("success");
      setNotice(
        appliedDefault
          ? `${modelProviderName(provider)} configuration stored securely. ${modelProviderName(provider)} · ${appliedDefault} is now the global default model.`
          : `${modelProviderName(provider)} configuration stored securely.`,
      );
    } catch (configureError) {
      setNoticeKind("error");
      setNotice(
        configureError instanceof Error ? configureError.message : String(configureError),
      );
    } finally {
      setWorking(false);
    }
  }

  async function configureEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const mode = String(data.get("mode")) as Integration["mode"];
    setWorking(true);
    setNotice(null);
    try {
      await window.coworker.integrations.configureEmail({
        name: mode === "local-outbox" ? "Local outbox" : "Resend",
        mode,
        apiKey: String(data.get("apiKey") || "") || undefined,
        fromAddress: String(data.get("fromAddress") || "") || undefined,
      });
      await onChanged();
      setNoticeKind("success");
      setNotice("Email integration updated.");
    } finally {
      setWorking(false);
    }
  }

  async function configureWebSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const provider = webSearchProvider;
    setWorking(true);
    setNotice(null);
    try {
      const result = await window.coworker.integrations.configureWebSearch({
        provider,
        apiKey: String(data.get("apiKey") ?? ""),
      });
      setCredentialStatus((current) => ({ ...current, [result.key]: true }));
      form.reset();
      setNoticeKind("success");
      setNotice(`${providerLabel(provider)} search key stored securely.`);
    } catch (configureError) {
      setNoticeKind("error");
      setNotice(configureError instanceof Error ? configureError.message : String(configureError));
    } finally {
      setWorking(false);
    }
  }

  async function discardUnreadableCredentials() {
    setWorking(true);
    setNotice(null);
    try {
      await Promise.all(
        unreadableKeys.map((key) => window.coworker.integrations.removeCredential(key)),
      );
      const discarded = unreadableKeys.length;
      setUnreadableKeys([]);
      setNoticeKind("success");
      setNotice(
        `Discarded ${discarded} unreadable credential${discarded === 1 ? "" : "s"}. Save a new key whenever you need that provider again.`,
      );
    } catch (discardError) {
      setNoticeKind("error");
      setNotice(discardError instanceof Error ? discardError.message : String(discardError));
    } finally {
      setWorking(false);
    }
  }

  async function installSkill(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setWorking(true);
    setNotice(null);
    try {
      const skill = await window.coworker.skills.installFromUrl(String(data.get("url")));
      form.reset();
      await onChanged();
      setNoticeKind("success");
      setNotice(`${skill.name} is now available to every coworker configuration.`);
    } catch (installError) {
      setNoticeKind("error");
      setNotice(installError instanceof Error ? installError.message : String(installError));
    } finally {
      setWorking(false);
    }
  }

  async function uploadSkill(file: File | undefined) {
    if (!file) return;
    setWorking(true);
    setNotice(null);
    try {
      const isPackage = /\.(?:skill|zip)$/i.test(file.name);
      if (!isPackage && !/\.md$/i.test(file.name)) {
        throw new Error("Upload skill.md, a .skill package, or a .zip package.");
      }
      if (file.size > (isPackage ? 10_000_000 : 1_000_000)) {
        throw new Error(isPackage ? "Skill packages must be 10 MB or smaller." : "Skill files must be 1 MB or smaller.");
      }
      const skill = isPackage
        ? await window.coworker.skills.installFromPackage(
            file.name,
            bytesToBase64(await file.arrayBuffer()),
          )
        : await window.coworker.skills.installFromContent(await file.text());
      await onChanged();
      setNoticeKind("success");
      setNotice(
        coworkers.length
          ? `${skill.name} was installed. Enable it for the coworkers below that should use it.`
          : `${skill.name} was installed and is available for future coworker configuration.`,
      );
    } catch (uploadError) {
      setNoticeKind("error");
      setNotice(readableError(uploadError));
    } finally {
      setWorking(false);
    }
  }

  async function toggleCoworkerSkill(coworker: Coworker, skill: Skill, enabled: boolean) {
    setWorking(true);
    setNotice(null);
    try {
      await window.coworker.coworkers.update(coworker.id, {
        enabledSkillIds: enabled
          ? [...coworker.enabledSkillIds, skill.id]
          : coworker.enabledSkillIds.filter((id) => id !== skill.id),
      });
      await onChanged();
    } catch (toggleError) {
      setNoticeKind("error");
      setNotice(toggleError instanceof Error ? toggleError.message : String(toggleError));
    } finally {
      setWorking(false);
    }
  }

  async function removeSkill(skill: Skill) {
    if (!confirm(`Remove the global skill “${skill.name}”?`)) return;
    setWorking(true);
    try {
      await window.coworker.skills.remove(skill.id);
      await onChanged();
      setNoticeKind("success");
      setNotice(`${skill.name} was removed.`);
    } catch (removeError) {
      setNoticeKind("error");
      setNotice(removeError instanceof Error ? removeError.message : String(removeError));
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="page settings-page">
      <PageHeader
        eyebrow="Workroom controls"
        title="Settings"
        description="Manage local behavior, model access, integrations, and data."
      />

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {(["general", "models", "skills", "integrations", "data"] as SettingsTab[]).map((item) => (
            <button className={tab === item ? "active" : ""} key={item} onClick={() => setTab(item)}>
              {item[0]?.toUpperCase()}
              {item.slice(1)}
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {unreadableKeys.length > 0 ? (
            <div className="settings-notice error" role="alert">
              <p>
                {unreadableKeys.length === 1
                  ? "1 saved credential can no longer be decrypted because it was encrypted under the app's previous name:"
                  : `${unreadableKeys.length} saved credentials can no longer be decrypted because they were encrypted under the app's previous name:`}
              </p>
              <ul className="unreadable-credential-list">
                {unreadableKeys.map((key) => {
                  const location = credentialLocation(key);
                  return (
                    <li key={key}>
                      <strong>{location.label}</strong>
                      <button
                        className="text-button"
                        onClick={() => setTab(location.tab)}
                        type="button"
                      >
                        Open {location.tabLabel}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <p>
                Save a new key to replace it, or discard it if you no longer use that provider.
              </p>
              <button
                className="ghost-button"
                disabled={working}
                onClick={() => void discardUnreadableCredentials()}
                type="button"
              >
                Discard unreadable {unreadableKeys.length === 1 ? "credential" : "credentials"}
              </button>
            </div>
          ) : null}
          {notice ? (
            <div
              className={noticeKind === "error" ? "settings-notice error" : "settings-notice"}
              role={noticeKind === "error" ? "alert" : "status"}
            >
              {notice}
            </div>
          ) : null}
          {tab === "general" ? (
            <section className="settings-section">
              <span className="eyebrow">Desktop behavior</span>
              <h2>Keep the room available</h2>
              <p>Schedules can run only while the app or its tray process remains active.</p>
              <div className="settings-rows">
                <label className="settings-row">
                  <span>
                    <strong>Run in the background</strong>
                    <small>Closing the window keeps coworkers and schedules available in the tray.</small>
                  </span>
                  <span className="toggle">
                    <input
                      type="checkbox"
                      checked={settings.runInBackground}
                      disabled={working}
                      onChange={(event) =>
                        void patchSettings({ runInBackground: event.target.checked })
                      }
                    />
                    <span />
                  </span>
                </label>
                <label className="settings-row">
                  <span>
                    <strong>Launch at login</strong>
                    <small>Start the local scheduler when you sign in to this computer.</small>
                  </span>
                  <span className="toggle">
                    <input
                      type="checkbox"
                      checked={settings.launchAtLogin}
                      disabled={working}
                      onChange={(event) =>
                        void patchSettings({ launchAtLogin: event.target.checked })
                      }
                    />
                    <span />
                  </span>
                </label>
                <label className="settings-row">
                  <span>
                    <strong>Show model reasoning</strong>
                    <small>
                      Display a collapsible “Thinking” block in chats when a model streams its
                      reasoning before answering.
                    </small>
                  </span>
                  <span className="toggle">
                    <input
                      type="checkbox"
                      checked={settings.showReasoning}
                      disabled={working}
                      onChange={(event) =>
                        void patchSettings({ showReasoning: event.target.checked })
                      }
                    />
                    <span />
                  </span>
                </label>
              </div>
              <div className="theme-settings">
                <span className="eyebrow">Appearance</span>
                <h2>Color theme</h2>
                <p>Retints the whole app. The change applies immediately.</p>
                <div className="theme-picker" role="group" aria-label="Color theme">
                  {themeOptions.map((option) => (
                    <button
                      aria-pressed={settings.theme === option.id}
                      className="theme-option"
                      data-theme={option.id}
                      disabled={working}
                      key={option.id}
                      onClick={() => void patchSettings({ theme: option.id })}
                      type="button"
                    >
                      <span className="theme-option-swatch" aria-hidden="true" />
                      <span>
                        <strong>{option.label}</strong>
                        <small>{option.description}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <form className="global-instructions-form" onSubmit={saveGlobalInstructions}>
                <span>
                  <strong>Global operating instructions</strong>
                  <small>
                    Applied to every coworker alongside its own operating instructions. Built-in
                    tool and approval safeguards still apply.
                  </small>
                </span>
                <textarea
                  aria-label="Global operating instructions"
                  disabled={working}
                  maxLength={50_000}
                  onChange={(event) => setGlobalInstructions(event.target.value)}
                  rows={7}
                  value={globalInstructions}
                />
                <div>
                  <small>
                    Use this for shared behavior, such as asking follow-up questions when required
                    information is missing.
                  </small>
                  <button
                    className="primary-button"
                    disabled={
                      working || globalInstructions.trim() === settings.globalOperatingInstructions
                    }
                  >
                    Save instructions
                  </button>
                </div>
              </form>
            </section>
          ) : null}

          {tab === "models" ? (
            <section className="settings-section">
              <span className="eyebrow">Reasoning providers</span>
              <h2>Model credentials</h2>
              <p>
                Keys and endpoint settings are encrypted through the operating system. They are
                never returned to the renderer or written as plaintext in SQLite. Model access is
                verified before the configuration is saved.
              </p>
              <div className="provider-grid model-provider-grid">
                {remoteModelProviderDefinitions.map((provider) => (
                  <button
                    aria-pressed={modelProvider === provider.id}
                    className={`provider-card model-provider-card${
                      modelProvider === provider.id ? " selected" : ""
                    }`}
                    key={provider.id}
                    onClick={() => {
                      setModelProvider(provider.id);
                      setNotice(null);
                    }}
                    type="button"
                  >
                    <span>
                      <strong>{provider.label}</strong>
                      <small>
                        {credentialStatus[modelProviderCredentialKey(provider.id)]
                          ? "Connected"
                          : "Not connected"}
                        {settings.defaultModelProvider === provider.id ? " · Default" : ""}
                      </small>
                    </span>
                    <span
                      className={
                        credentialStatus[modelProviderCredentialKey(provider.id)]
                          ? "connection-dot connected"
                          : "connection-dot"
                      }
                      aria-hidden="true"
                    />
                  </button>
                ))}
              </div>
              <form
                className="inline-credential-form model-credential-form"
                key={modelProvider}
                onSubmit={configureModel}
              >
                <div className="credential-form-heading">
                  <strong>{modelProviderName(modelProvider)}</strong>
                  <small>
                    {credentialStatus[modelProviderCredentialKey(modelProvider)]
                      ? "Connected · enter new credentials to replace the saved configuration"
                      : "Enter the provider credentials below"}
                  </small>
                </div>
                {getModelProviderDefinition(modelProvider).baseUrlMode !== "none" ? (
                  <input
                    aria-label={`${modelProviderName(modelProvider)} base URL`}
                    name="baseUrl"
                    type="url"
                    placeholder={
                      getModelProviderDefinition(modelProvider).defaultBaseUrl ??
                      "https://models.example.com/v1"
                    }
                    defaultValue={getModelProviderDefinition(modelProvider).defaultBaseUrl}
                    required={
                      getModelProviderDefinition(modelProvider).baseUrlMode === "required"
                    }
                  />
                ) : null}
                <input
                  aria-label={`${modelProviderName(modelProvider)} API key`}
                  name="apiKey"
                  type="password"
                  placeholder={
                    credentialStatus[modelProviderCredentialKey(modelProvider)]
                      ? "Stored — enter to replace"
                      : getModelProviderDefinition(modelProvider).apiKeyPlaceholder
                  }
                  required={
                    getModelProviderDefinition(modelProvider).apiKeyRequired &&
                    !credentialStatus[modelProviderCredentialKey(modelProvider)]
                  }
                />
                <div className="credential-default-model">
                  <label className="settings-row">
                    <span>
                      <strong>Use as the global default model</strong>
                      <small>
                        New coworkers start with this model. You can override it per coworker.
                      </small>
                    </span>
                    <span className="toggle">
                      <input
                        checked={makeDefaultModel}
                        disabled={working}
                        onChange={(event) => setMakeDefaultModel(event.target.checked)}
                        type="checkbox"
                      />
                      <span />
                    </span>
                  </label>
                  {makeDefaultModel ? (
                    credentialStatus[modelProviderCredentialKey(modelProvider)] &&
                    credentialsLoaded ? (
                      <ModelSelector
                        disabled={working}
                        onChange={setDefaultModelChoice}
                        provider={modelProvider}
                        value={defaultModelChoice}
                      />
                    ) : (
                      <small className="credential-default-model-hint">
                        The model list loads once the key is verified. Saving connects the
                        provider and makes its first available model the default; you can change
                        it here right after.
                      </small>
                    )
                  ) : null}
                </div>
                <button className="primary-button" disabled={working}>
                  Verify and save
                </button>
              </form>
              <small className="settings-model-default-note">
                {settings.defaultModelProvider && settings.defaultModelName
                  ? `Current global default: ${modelProviderName(settings.defaultModelProvider)} · ${settings.defaultModelName}`
                  : "No global default model configured yet. Connect a provider with the switch on to set one."}
              </small>
            </section>
          ) : null}

          {tab === "skills" ? (
            <section className="settings-section skills-settings">
              <span className="eyebrow">Agent Skills standard</span>
              <h2>Global skills, configured per coworker</h2>
              <p>
                Install a compliant skill.md directly, or upload a standard .skill/.zip package
                containing one root folder whose name matches the skill. Packaged resources are
                preserved; each coworker can opt in independently.
              </p>
              <form className="skill-url-form" onSubmit={installSkill}>
                <input
                  aria-label="Agent Skill URL"
                  name="url"
                  placeholder="https://example.com/my-skill/SKILL.md"
                  required
                  type="url"
                />
                <button className="primary-button" disabled={working}>Install skill</button>
              </form>
              <label className="skill-upload-button">
                <input
                  accept=".md,.skill,.zip,text/markdown,application/zip"
                  disabled={working}
                  onChange={(event) => {
                    void uploadSkill(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                  type="file"
                />
                <span>Upload skill.md, .skill, or .zip</span>
              </label>

              <div className="skill-settings-list">
                {skills.map((skill) => (
                  <article className="skill-settings-card" key={skill.id}>
                    <header>
                      <span>
                        <strong>{skill.name}</strong>
                        <small>{skill.bundled ? "Bundled" : skill.sourceUrl ?? "Installed"}</small>
                      </span>
                      {!skill.bundled ? (
                        <button
                          className="ghost-button danger"
                          disabled={working}
                          onClick={() => void removeSkill(skill)}
                          type="button"
                        >
                          Remove
                        </button>
                      ) : null}
                    </header>
                    <p>{skill.description}</p>
                    <div className="skill-coworker-toggles">
                      {coworkers.map((coworker) => (
                        <label key={coworker.id}>
                          <input
                            checked={coworker.enabledSkillIds.includes(skill.id)}
                            disabled={working}
                            onChange={(event) =>
                              void toggleCoworkerSkill(coworker, skill, event.target.checked)
                            }
                            type="checkbox"
                          />
                          <span>{coworker.name}</span>
                        </label>
                      ))}
                    </div>
                  </article>
                ))}
              </div>

              <span className="eyebrow skills-provider-eyebrow">Web search credentials</span>
              <p>The web-search skill automatically uses the first configured provider available.</p>
              <div className="provider-grid model-provider-grid">
                {webSearchProviders.map((provider) => (
                  <button
                    aria-pressed={webSearchProvider === provider}
                    className={`provider-card model-provider-card${
                      webSearchProvider === provider ? " selected" : ""
                    }`}
                    key={provider}
                    onClick={() => {
                      setWebSearchProvider(provider);
                      setNotice(null);
                    }}
                    type="button"
                  >
                    <span>
                      <strong>{providerLabel(provider)}</strong>
                      <small>
                        {credentialStatus[`web-search:${provider}`] ? "Connected" : "Not connected"}
                      </small>
                    </span>
                    <span
                      aria-hidden="true"
                      className={
                        credentialStatus[`web-search:${provider}`]
                          ? "connection-dot connected"
                          : "connection-dot"
                      }
                    />
                  </button>
                ))}
              </div>
              <form
                className="inline-credential-form model-credential-form"
                key={webSearchProvider}
                onSubmit={configureWebSearch}
              >
                <div className="credential-form-heading">
                  <strong>{providerLabel(webSearchProvider)}</strong>
                  <small>
                    {credentialStatus[`web-search:${webSearchProvider}`]
                      ? "Connected · enter a new key to replace the saved one"
                      : "Enter the provider API key below"}
                  </small>
                </div>
                <input
                  aria-label={`${providerLabel(webSearchProvider)} API key`}
                  name="apiKey"
                  placeholder={
                    credentialStatus[`web-search:${webSearchProvider}`]
                      ? "Stored — enter to replace"
                      : `${providerLabel(webSearchProvider)} API key`
                  }
                  required
                  type="password"
                />
                <button className="primary-button" disabled={working}>Save search key</button>
              </form>
            </section>
          ) : null}

          {tab === "integrations" ? (
            <section className="settings-section">
              <span className="eyebrow">Controlled adapters</span>
              <h2>Email delivery</h2>
              <p>
                Local outbox writes an auditable .eml file. Resend performs a real send only after
                approval.
              </p>
              <form className="form-stack integration-form" onSubmit={configureEmail}>
                <label>
                  <span>Delivery mode</span>
                  <select
                    name="mode"
                    defaultValue={integrations.find((item) => item.type === "email")?.mode ?? "local-outbox"}
                  >
                    <option value="local-outbox">Local outbox (safe demo)</option>
                    <option value="resend">Resend API</option>
                  </select>
                </label>
                <label>
                  <span>From address</span>
                  <input
                    name="fromAddress"
                    type="email"
                    defaultValue={String(
                      integrations.find((item) => item.type === "email")?.config.fromAddress ??
                        "coworker@localhost",
                    )}
                  />
                </label>
                <label>
                  <span>Resend API key</span>
                  <input
                    name="apiKey"
                    type="password"
                    placeholder={
                      credentialStatus["integration:email:resend"]
                        ? "Stored — enter a value to replace"
                        : "Required only for Resend"
                    }
                  />
                </label>
                <div>
                  <button className="primary-button" disabled={working}>
                    Save email integration
                  </button>
                </div>
              </form>
            </section>
          ) : null}

          {tab === "data" ? (
            <section className="settings-section">
              <span className="eyebrow">Local data</span>
              <h2>Your workspace lives here</h2>
              <p>
                Coworker version <strong>{version}</strong>
              </p>
              <p>SQLite, artifacts, encrypted credential blobs, logs, and the local email outbox.</p>
              <p>
                Provider failures are recorded in <code>logs/provider-errors.jsonl</code>. API keys
                and prompt contents are excluded and secret-like values are redacted.
              </p>
              <div className="data-path">
                <Icon name="file" />
                <code>{dataPath}</code>
              </div>
              <div className="data-actions">
                <button className="secondary-button" onClick={() => void window.coworker.app.openDataFolder()}>
                  Open data folder
                </button>
                <button
                  className="primary-button"
                  onClick={() =>
                    void window.coworker.app.backup().then((path) => {
                      if (path) {
                        setNoticeKind("success");
                        setNotice(`Database backup saved to ${path}`);
                      }
                    })
                  }
                >
                  Back up database
                </button>
                <button
                  className="primary-button"
                  onClick={() => void exportDataBackup()}
                  type="button"
                >
                  <Icon name="download" /> Export all data
                </button>
              </div>

              <div className="provider-diagnostics">
                <header>
                  <span>
                    <span className="eyebrow">Diagnostics</span>
                    <h3>Diagnostics and support</h3>
                    <small>
                      Download redacted application and provider logs to send with a support request.
                    </small>
                  </span>
                  <div>
                    <button
                      className="secondary-button"
                      disabled={diagnosticsLoading}
                      onClick={() => void refreshProviderErrors()}
                      type="button"
                    >
                      Refresh
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() => void copyProviderReport()}
                      type="button"
                    >
                      Copy report
                    </button>
                    <button
                      className="primary-button"
                      onClick={() => void exportSupportBundle()}
                      type="button"
                    >
                      <Icon name="download" /> Download diagnostics ZIP
                    </button>
                  </div>
                </header>
                <p className="diagnostics-privacy-note">
                  Credentials and account names are redacted where recognized. Review the ZIP
                  before sending it because technical logs can contain file names and error context.
                </p>

                {diagnosticsLoading ? (
                  <div className="provider-diagnostics-empty">Loading provider logs…</div>
                ) : providerErrors.length === 0 ? (
                  <div className="provider-diagnostics-empty">
                    <Icon name="check" /> No provider errors have been recorded.
                  </div>
                ) : (
                  <div className="provider-diagnostics-list">
                    {providerErrors.map((error, index) => (
                      <article key={`${error.timestamp}:${error.runId ?? error.taskId ?? index}`}>
                        <header>
                          <span>
                            <strong>{error.provider}</strong>
                            {error.model ? <code>{error.model}</code> : null}
                            <b>{error.phase.replaceAll("_", " ")}</b>
                            {error.status ? <b>HTTP {error.status}</b> : null}
                          </span>
                          <time dateTime={error.timestamp}>{formatDiagnosticTime(error.timestamp)}</time>
                        </header>
                        <p>{error.message}</p>
                        <details>
                          <summary>Technical details</summary>
                          <pre>{JSON.stringify(error, null, 2)}</pre>
                        </details>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function credentialLocation(key: string): {
  label: string;
  tab: SettingsTab;
  tabLabel: string;
} {
  const webSearch = webSearchProviders.find((provider) => key === `web-search:${provider}`);
  if (webSearch) {
    return {
      label: `${providerLabel(webSearch)} web search key`,
      tab: "skills",
      tabLabel: "Skills",
    };
  }
  if (key === "integration:email:resend") {
    return { label: "Resend email key", tab: "integrations", tabLabel: "Integrations" };
  }
  const model = remoteModelProviderDefinitions.find(
    (provider) =>
      key === modelProviderCredentialKey(provider.id) ||
      key === modelProviderBaseUrlKey(provider.id),
  );
  if (model) {
    return {
      label: key.endsWith(":base-url")
        ? `${model.label} base URL`
        : `${model.label} API key`,
      tab: "models",
      tabLabel: "Models",
    };
  }
  return { label: key, tab: "models", tabLabel: "Models" };
}

function providerLabel(provider: WebSearchProvider): string {
  return provider === "serpapi"
    ? "SerpAPI"
    : `${provider[0]?.toUpperCase()}${provider.slice(1)}`;
}

function formatDiagnosticTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}
