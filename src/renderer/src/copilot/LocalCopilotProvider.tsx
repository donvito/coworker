import { useEffect, useMemo, type ReactNode } from "react";
import type { AbstractAgent } from "@ag-ui/client";
import {
  CopilotKitContext,
  CopilotKitCoreReact,
} from "@copilotkit/react-core/v2/context";

const noExecutingTools: ReadonlySet<string> = new Set();

export function LocalCopilotProvider({
  agentId,
  agent,
  children,
}: {
  agentId: string;
  agent: AbstractAgent;
  children: ReactNode;
}) {
  const copilotkit = useMemo(() => {
    const core = new CopilotKitCoreReact({
      deferInitialConnection: true,
      agents__unsafe_dev_only: { [agentId]: agent },
    });
    core.setDefaultThrottleMs(24);
    return core;
  }, [agent, agentId]);

  useEffect(() => {
    copilotkit.connect();
  }, [copilotkit]);

  const value = useMemo(
    () => ({ copilotkit, executingToolCallIds: noExecutingTools }),
    [copilotkit],
  );

  return <CopilotKitContext.Provider value={value}>{children}</CopilotKitContext.Provider>;
}
