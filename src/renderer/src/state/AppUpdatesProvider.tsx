import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { AppUpdateState } from "@shared/contracts";
import { AppUpdateDialog } from "../components/AppUpdateDialog";

interface AppUpdatesContextValue {
  availableVersion: string | null;
  busy: boolean;
  open: boolean;
  showAvailableUpdate: () => void;
}

const AppUpdatesContext = createContext<AppUpdatesContextValue | null>(null);

export function useAppUpdates() {
  return useContext(AppUpdatesContext);
}

export function AppUpdatesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppUpdateState>({ checking: false, availableVersion: null, notice: null });
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const actionInFlight = useRef(false);

  useEffect(() => {
    let disposed = false;
    let receivedEvent = false;
    const unsubscribe = window.coworker.events.subscribe((event) => {
      if (event.type !== "app.update") return;
      receivedEvent = true;
      setState(event.state);
      setActionError(null);
    });
    // Read retained startup state without overwriting a newer IPC event.
    void window.coworker.app.getUpdateState().then((initialState) => {
      if (!disposed && !receivedEvent) setState(initialState);
    }).catch(() => {});
    return () => { disposed = true; unsubscribe(); };
  }, []);

  async function download() {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setWorking(true);
    setActionError(null);
    try {
      await window.coworker.app.openUpdateRelease();
    } catch (error) {
      setActionError(`Could not open the release page: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      actionInFlight.current = false;
      setWorking(false);
    }
  }

  async function dismiss() {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setWorking(true);
    setActionError(null);
    try {
      setState(await window.coworker.app.dismissUpdateNotice());
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      actionInFlight.current = false;
      setWorking(false);
    }
  }

  function showAvailableUpdate() {
    setActionError(null);
    setState((current) => current.availableVersion ? {
      ...current,
      notice: { kind: "available", version: current.availableVersion },
    } : current);
  }

  return (
    <AppUpdatesContext.Provider value={{
      availableVersion: state.availableVersion,
      busy: working || state.checking,
      open: state.notice?.kind === "available",
      showAvailableUpdate,
    }}>
      {children}
      {state.notice ? (
        <AppUpdateDialog
          notice={state.notice}
          busy={working}
          error={actionError}
          onDismiss={() => void dismiss()}
          onDownload={() => void download()}
        />
      ) : null}
    </AppUpdatesContext.Provider>
  );
}
