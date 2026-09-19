import type { AppUpdatesController } from "../state/app-updates";

function versionLabel(version: string | undefined): string {
  if (!version) return "";
  return /^\d/.test(version) ? `v${version}` : version;
}

function describeStatus(status: NonNullable<AppUpdatesController["status"]>): string {
  switch (status.state) {
    case "unsupported":
      return "Updates are checked only in installed builds.";
    case "idle":
      return "Updates have not been checked yet this session.";
    case "checking":
      return "Checking GitHub for a newer release…";
    case "up-to-date":
      return `You are on the latest version${status.checkedAt ? ` (checked ${new Date(status.checkedAt).toLocaleString()})` : ""}.`;
    case "available":
      return status.canInstall
        ? `${versionLabel(status.latestVersion)} is available to download.`
        : `${versionLabel(status.latestVersion)} is available on GitHub. This build cannot install updates in place, so download the new installer from the release page.`;
    case "downloading":
      return `Downloading ${versionLabel(status.latestVersion)}${typeof status.percent === "number" ? ` — ${status.percent}%` : ""}…`;
    case "downloaded":
      return `${versionLabel(status.latestVersion)} is downloaded and will install when you restart.`;
    case "error":
      return `The last update check failed: ${status.error ?? "unknown error"}`;
  }
}

/** Manual update controls shown in Settings. */
export function UpdateSettings({
  updates,
  autoUpdate,
  disabled,
  onToggleAutoUpdate,
}: {
  updates: AppUpdatesController;
  autoUpdate: boolean;
  disabled: boolean;
  onToggleAutoUpdate: (enabled: boolean) => void;
}) {
  const status = updates.status;
  const busy = updates.busy || status?.state === "checking" || status?.state === "downloading";
  return (
    <div className="update-settings">
      <label className="settings-row">
        <span>
          <strong>Install updates automatically</strong>
          <small>
            Check GitHub releases on launch and every few hours, and download new versions in the
            background. You always choose when to restart.
          </small>
        </span>
        <span className="toggle">
          <input
            type="checkbox"
            checked={autoUpdate}
            disabled={disabled}
            onChange={(event) => onToggleAutoUpdate(event.target.checked)}
          />
          <span />
        </span>
      </label>
      <p className="update-status" role="status">
        {status ? describeStatus(status) : "Loading update status…"}
      </p>
      <div className="data-actions">
        <button
          className="secondary-button"
          disabled={busy || !status || status.state === "unsupported" || status.state === "downloaded"}
          onClick={() => void updates.check()}
          type="button"
        >
          {status?.state === "checking" ? "Checking…" : "Check for updates"}
        </button>
        {status?.state === "available" && status.canInstall ? (
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => void updates.download()}
            type="button"
          >
            Download update
          </button>
        ) : null}
        {status?.state === "downloaded" ? (
          <button
            className="primary-button"
            disabled={updates.busy}
            onClick={() => void updates.install()}
            type="button"
          >
            Restart to update
          </button>
        ) : null}
        {status?.releaseUrl && status.state !== "unsupported" ? (
          <button
            className="secondary-button"
            disabled={updates.busy}
            onClick={() => void updates.openReleasePage()}
            type="button"
          >
            {status.state === "available" && !status.canInstall ? "Download from GitHub" : "View releases"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
