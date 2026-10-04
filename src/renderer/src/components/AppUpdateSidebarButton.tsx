import { useAppUpdates } from "../state/AppUpdatesProvider";
import { Icon } from "./Icon";

export function AppUpdateSidebarButton() {
  const updates = useAppUpdates();
  if (!updates?.availableVersion) return null;

  return (
    <button
      aria-expanded={updates.open}
      aria-haspopup="dialog"
      aria-label={`Coworker ${updates.availableVersion} is available. View update`}
      className="app-update-sidebar-button"
      disabled={updates.busy}
      onClick={updates.showAvailableUpdate}
      title={`Coworker ${updates.availableVersion} is available`}
      type="button"
    >
      <Icon name="download" />
      <span>Update available</span>
    </button>
  );
}
