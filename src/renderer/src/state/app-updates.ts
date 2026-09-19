import { useCallback, useEffect, useState } from "react";
import type { AppUpdateStatus, DesktopEvent } from "@shared/contracts";

export interface AppUpdatesController {
  status: AppUpdateStatus | null;
  busy: boolean;
  check: () => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
  openReleasePage: () => Promise<void>;
}

/** Tracks the main-process updater and exposes its actions to the UI. */
export function useAppUpdates(lastEvent: DesktopEvent | null): AppUpdatesController {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.coworker.updates
      .status()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (lastEvent?.type === "update.status") setStatus(lastEvent.status);
  }, [lastEvent]);

  const run = useCallback(async (action: () => Promise<AppUpdateStatus | void>) => {
    setBusy(true);
    try {
      const next = await action();
      if (next) setStatus(next);
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    status,
    busy,
    check: () => run(() => window.coworker.updates.check()),
    download: () => run(() => window.coworker.updates.download()),
    install: () => run(() => window.coworker.updates.install()),
    openReleasePage: () => run(() => window.coworker.updates.openReleasePage()),
  };
}
