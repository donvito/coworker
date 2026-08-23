import { useEffect, useState, type FormEvent } from "react";
import type { AppSettings, Integration } from "@shared/contracts";
import { Icon } from "../components/Icon";
import { PageHeader } from "../components/Primitives";

type SettingsTab = "general" | "models" | "integrations" | "data";

export function SettingsPage({
  settings,
  integrations,
  dataPath,
  onChanged,
}: {
  settings: AppSettings;
  integrations: Integration[];
  dataPath: string;
  onChanged: () => Promise<void>;
}) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeKind, setNoticeKind] = useState<"success" | "error">("success");
  const [credentialStatus, setCredentialStatus] = useState<Record<string, boolean>>({});

  useEffect(() => {
    void Promise.all(
      ["model:anthropic", "model:openai", "model:google", "integration:email:resend"].map(
        async (key) => [key, (await window.coworker.integrations.credentialStatus(key)).configured] as const,
      ),
    ).then((entries) => setCredentialStatus(Object.fromEntries(entries)));
  }, [integrations]);

  async function patchSettings(patch: Partial<AppSettings>) {
    setWorking(true);
    try {
      await window.coworker.app.updateSettings(patch);
      await onChanged();
    } finally {
      setWorking(false);
    }
  }

  async function configureModel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const provider = String(data.get("provider")) as "anthropic" | "openai" | "google";
    setWorking(true);
    setNotice(null);
    try {
      const result = await window.coworker.integrations.configureModel({
        provider,
        apiKey: String(data.get("apiKey")),
      });
      setCredentialStatus((current) => ({ ...current, [result.key]: true }));
      form.reset();
      setNoticeKind("success");
      setNotice(`${providerName(provider)} credential stored securely.`);
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

  return (
    <div className="page settings-page">
      <PageHeader
        eyebrow="Workroom controls"
        title="Settings"
        description="Manage local behavior, model access, integrations, and data."
      />

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {(["general", "models", "integrations", "data"] as SettingsTab[]).map((item) => (
            <button className={tab === item ? "active" : ""} key={item} onClick={() => setTab(item)}>
              {item[0]?.toUpperCase()}
              {item.slice(1)}
            </button>
          ))}
        </nav>

        <div className="settings-content">
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
              </div>
            </section>
          ) : null}

          {tab === "models" ? (
            <section className="settings-section">
              <span className="eyebrow">Reasoning providers</span>
              <h2>Model credentials</h2>
              <p>
                Keys are encrypted through the operating system. They are never returned to the
                renderer or written as plaintext in SQLite. Model access is verified before a key
                is saved.
              </p>
              <div className="provider-grid">
                {(["anthropic", "openai", "google"] as const).map((provider) => (
                  <div className="provider-card" key={provider}>
                    <span className="provider-monogram">{provider[0]?.toUpperCase()}</span>
                    <span>
                      <strong>{providerName(provider)}</strong>
                      <small>
                        {credentialStatus[`model:${provider}`] ? "Credential configured" : "Not connected"}
                      </small>
                    </span>
                    <span
                      className={
                        credentialStatus[`model:${provider}`]
                          ? "connection-dot connected"
                          : "connection-dot"
                      }
                    />
                  </div>
                ))}
              </div>
              <form className="inline-credential-form" onSubmit={configureModel}>
                <select name="provider" aria-label="Model provider">
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI</option>
                  <option value="google">Google</option>
                </select>
                <input name="apiKey" type="password" placeholder="Paste API key" required />
                <button className="primary-button" disabled={working}>
                  Store securely
                </button>
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
              <h2>Your workroom lives here</h2>
              <p>SQLite, artifacts, encrypted credential blobs, logs, and the local email outbox.</p>
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
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function providerName(provider: "anthropic" | "openai" | "google"): string {
  return provider === "openai"
    ? "OpenAI"
    : provider === "anthropic"
      ? "Anthropic"
      : "Google";
}
