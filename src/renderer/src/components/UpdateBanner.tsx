import { useState } from "react";
import type { AppUpdatesController } from "../state/app-updates";
import { Icon } from "./Icon";

function versionLabel(version: string | undefined): string {
  if (!version) return "a new version";
  return /^\d/.test(version) ? `v${version}` : version;
}

/** Surfaces a ready or available update above the current page. */
export function UpdateBanner({ updates }: { updates: AppUpdatesController }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const status = updates.status;
  if (!status) return null;
  const key = `${status.state}:${status.latestVersion ?? ""}`;
  if (dismissed === key) return null;

  if (status.state === "downloaded") {
    return (
      <div className="update-banner ready" role="status">
        <Icon name="download" />
        <span>
          <strong>Coworker {versionLabel(status.latestVersion)} is ready.</strong> Restart to finish
          installing the update.
        </span>
        <button
          className="primary-button"
          disabled={updates.busy}
          onClick={() => void updates.install()}
          type="button"
        >
          Restart to update
        </button>
        <button
          aria-label="Dismiss update notice"
          className="ghost-button"
          onClick={() => setDismissed(key)}
          type="button"
        >
          Later
        </button>
      </div>
    );
  }

  if (status.state === "downloading") {
    return (
      <div className="update-banner" role="status">
        <Icon name="download" />
        <span>
          Downloading Coworker {versionLabel(status.latestVersion)}
          {typeof status.percent === "number" ? ` — ${status.percent}%` : "…"}
        </span>
      </div>
    );
  }

  if (status.state === "available") {
    return (
      <div className="update-banner" role="status">
        <Icon name="spark" />
        <span>
          <strong>Coworker {versionLabel(status.latestVersion)} is available.</strong>{" "}
          {status.canInstall
            ? "Download it now and restart when you are ready."
            : "Download the new build from GitHub to update."}
        </span>
        {status.canInstall ? (
          <button
            className="primary-button"
            disabled={updates.busy}
            onClick={() => void updates.download()}
            type="button"
          >
            Download update
          </button>
        ) : (
          <button
            className="primary-button"
            disabled={updates.busy}
            onClick={() => void updates.openReleasePage()}
            type="button"
          >
            View release
          </button>
        )}
        <button
          aria-label="Dismiss update notice"
          className="ghost-button"
          onClick={() => setDismissed(key)}
          type="button"
        >
          Later
        </button>
      </div>
    );
  }

  return null;
}
