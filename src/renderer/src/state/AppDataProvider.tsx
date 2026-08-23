import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AppSnapshot, DesktopEvent } from "@shared/contracts";

interface AppDataContextValue {
  snapshot: AppSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  lastEvent: DesktopEvent | null;
}

const AppDataContext = createContext<AppDataContextValue | null>(null);

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<DesktopEvent | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await window.coworker.app.bootstrap();
      setSnapshot(next);
      setError(null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return window.coworker.events.subscribe((event) => {
      setLastEvent(event);
      if (
        event.type === "agent.event" ||
        event.type === "notification" ||
        event.type === "navigation.requested"
      )
        return;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => void refresh(), 40);
    });
  }, [refresh]);

  const value = useMemo(
    () => ({ snapshot, loading, error, refresh, lastEvent }),
    [snapshot, loading, error, refresh, lastEvent],
  );
  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

export function useAppData(): AppDataContextValue {
  const context = useContext(AppDataContext);
  if (!context) throw new Error("useAppData must be used inside AppDataProvider");
  return context;
}
