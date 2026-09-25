import { useCallback, useEffect, useState } from "react";
import type { AppSettings, AppUpdateState } from "@shared/contracts";
import { Icon } from "./Icon";

export function useAppUpdateState(): AppUpdateState | null {
  const [state, setState] = useState<AppUpdateState | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.coworker.updates
      ?.state()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () =>
      window.coworker.events?.subscribe((event) => {
        if (event.type === "app.update") setState(event.state);
      }),
    [],
  );

  return state;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function UpdateBanner({ onOpen }: { onOpen: () => void }) {
  const state = useAppUpdateState();
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const version = state?.release?.version;
  if (!state || !version || dismissedVersion === version) return null;
  if (state.status !== "available" && state.status !== "ready") return null;
  return (
    <div className="update-banner" role="status">
      <span>
        {state.status === "ready"
          ? `Coworker ${version} is downloaded and ready to install.`
          : `Coworker ${version} is available.`}
      </span>
      <span className="update-banner-actions">
        <button onClick={onOpen} type="button">View update</button>
        <button aria-label="Dismiss update notice" onClick={() => setDismissedVersion(version)} type="button">
          Later
        </button>
      </span>
    </div>
  );
}

export function UpdatePanel({
  settings,
  disabled,
  onPatchSettings,
}: {
  settings: AppSettings;
  disabled: boolean;
  onPatchSettings: (patch: Partial<AppSettings>) => void;
}) {
  const state = useAppUpdateState();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmingInstall, setConfirmingInstall] = useState(false);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setBusy(false);
    }
  }, []);

  if (!state) return null;
  const release = state.release;
  const working = busy || ["checking", "downloading", "installing"].includes(state.status);
  const progress = state.progress;
  const percent = progress?.totalBytes
    ? Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100))
    : null;
  const error = actionError ?? state.error;

  let summary: string;
  switch (state.status) {
    case "checking":
      summary = "Checking for updates…";
      break;
    case "up-to-date":
      summary = `You're on the latest version (${state.currentVersion}).`;
      break;
    case "available":
      summary = `Coworker ${release?.version} is available. You're on ${state.currentVersion}.`;
      break;
    case "downloading":
      summary = `Downloading Coworker ${release?.version}…`;
      break;
    case "ready":
      summary = `Coworker ${release?.version} is downloaded and ready to install.`;
      break;
    case "installing":
      summary = "Backing up your data and restarting to install the update…";
      break;
    default:
      summary = `You're on version ${state.currentVersion}.`;
  }

  return (
    <div className="update-panel">
      <header>
        <span>
          <span className="eyebrow">Updates</span>
          <h3>App updates</h3>
          <small>
            Updates never install on their own. Before installing, Coworker backs up and verifies your
            database, then runs any database migrations when the new version starts.
          </small>
        </span>
        <button
          className="secondary-button"
          disabled={working}
          onClick={() => void run(() => window.coworker.updates.check())}
          type="button"
        >
          Check for updates
        </button>
      </header>

      <p className="update-summary" aria-live="polite">{summary}</p>
      {state.checkedAt ? (
        <small className="update-meta">Last checked {new Date(state.checkedAt).toLocaleString()}</small>
      ) : null}

      {state.lastUpdate ? (
        <div className="settings-notice">
          Updated from {state.lastUpdate.fromVersion} to {state.lastUpdate.toVersion}. Your previous
          database was backed up to <code>{state.lastUpdate.backupPath}</code>.
        </div>
      ) : null}

      {error ? (
        <div className="settings-notice error" role="alert">
          {error}
        </div>
      ) : null}

      {release && ["available", "downloading", "ready", "installing"].includes(state.status) ? (
        <div className="update-release">
          <strong>{release.name}</strong>
          {release.publishedAt ? (
            <small>Released {new Date(release.publishedAt).toLocaleDateString()}</small>
          ) : null}
          {release.notes ? <pre className="update-notes">{release.notes}</pre> : null}

          {state.status === "downloading" && progress ? (
            <div className="update-progress">
              <progress max={100} value={percent ?? undefined} />
              <small>
                {formatBytes(progress.receivedBytes)}
                {progress.totalBytes ? ` of ${formatBytes(progress.totalBytes)}` : ""}
              </small>
            </div>
          ) : null}

          {!state.canInstall ? (
            <small className="update-meta">{state.installUnsupportedReason}</small>
          ) : null}
          {state.canInstall && !release.assetName ? (
            <small className="update-meta">This release has no download for this computer yet.</small>
          ) : null}

          {confirmingInstall && state.status === "ready" ? (
            <div className="update-confirm">
              <p>
                Coworker will pause coworkers and schedules, back up your database, then quit, install{" "}
                {release.version}, and reopen. Active tasks must finish first.
              </p>
              <div className="data-actions">
                <button
                  className="primary-button"
                  disabled={working}
                  onClick={() =>
                    void run(async () => {
                      await window.coworker.updates.install();
                      setConfirmingInstall(false);
                    })
                  }
                  type="button"
                >
                  Back up and restart
                </button>
                <button
                  className="secondary-button"
                  disabled={working}
                  onClick={() => setConfirmingInstall(false)}
                  type="button"
                >
                  Not now
                </button>
              </div>
            </div>
          ) : (
            <div className="data-actions">
              {state.canInstall && release.assetName && state.status === "available" ? (
                <button
                  className="primary-button"
                  disabled={working}
                  onClick={() => void run(() => window.coworker.updates.download())}
                  type="button"
                >
                  <Icon name="download" /> Download update
                </button>
              ) : null}
              {state.status === "ready" ? (
                <button
                  className="primary-button"
                  disabled={working}
                  onClick={() => setConfirmingInstall(true)}
                  type="button"
                >
                  Install and restart
                </button>
              ) : null}
              <button
                className="secondary-button"
                onClick={() => void window.coworker.updates.openReleasePage()}
                type="button"
              >
                View release
              </button>
            </div>
          )}
        </div>
      ) : null}

      <label className="settings-row">
        <span>
          <strong>Check for updates automatically</strong>
          <small>Look for new versions in the background and let you know. Nothing is downloaded or installed until you choose.</small>
        </span>
        <span className="toggle">
          <input
            type="checkbox"
            checked={settings.checkForUpdatesAutomatically}
            disabled={disabled}
            onChange={(event) =>
              onPatchSettings({ checkForUpdatesAutomatically: event.target.checked })
            }
          />
          <span />
        </span>
      </label>
    </div>
  );
}
