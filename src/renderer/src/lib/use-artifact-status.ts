import { useCallback, useEffect, useRef, useState } from "react";
import type { ArtifactFileStatus } from "@shared/contracts";

export function useArtifactStatus(id: string) {
  const [result, setResult] = useState<{ id: string; status: ArtifactFileStatus } | null>(null);
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    try {
      const status = await window.coworker.artifacts.status(id);
      if (request === revision.current) setResult({ id, status });
    } catch {
      if (request === revision.current) setResult({ id, status: "unavailable" });
    }
  }, [id]);

  useEffect(() => {
    void refresh();
    const unsubscribe = window.coworker.events.subscribe(event => {
      if (event.type === "entity.changed" && ["artifacts", "coworkers"].includes(event.entity)) void refresh();
    });
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => {
      ++revision.current;
      unsubscribe();
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  return { status: result?.id === id ? result.status : null, refresh };
}
