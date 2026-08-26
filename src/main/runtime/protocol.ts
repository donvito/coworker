import type { BaseEvent } from "@ag-ui/core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { Coworker } from "@shared/contracts";

export interface WorkerCoworkerConfig {
  coworker: Pick<
    Coworker,
    | "id"
    | "name"
    | "role"
    | "systemPrompt"
    | "modelProvider"
    | "modelName"
    | "enabledTools"
    | "sharedFolders"
  >;
  modelApiKey?: string;
  modelBaseUrl?: string;
  modelSupportsImages?: boolean;
  modelContextWindow?: number;
  globalOperatingInstructions: string;
  skills: Array<{ name: string; description: string }>;
  recentSkillUses: string[];
}

export type MainToWorkerMessage =
  | { type: "initialize"; config: WorkerCoworkerConfig }
  | {
      type: "run";
      taskId: string;
      runId: string;
      threadId: string;
      input: string;
      images?: ImageContent[];
      threadMessages?: unknown[];
      checkpoint?: unknown[];
      resume?: {
        decision: "approved" | "edited" | "rejected";
        toolName: string;
        result: unknown;
      };
    }
  | {
      type: "tool.response";
      requestId: string;
      response:
        | { kind: "completed"; result: unknown }
        | {
            kind: "approval";
            approvalId: string;
            summary: string;
            toolCallId: string;
          }
        | { kind: "denied"; reason: string };
    }
  | { type: "abort"; runId: string }
  | { type: "shutdown" };

export type WorkerToMainMessage =
  | { type: "ready"; coworkerId: string }
  | {
      type: "agui.event";
      coworkerId: string;
      taskId: string;
      runId: string;
      event: BaseEvent;
    }
  | {
      type: "tool.request";
      coworkerId: string;
      taskId: string;
      runId: string;
      requestId: string;
      toolCallId: string;
      toolName: string;
      arguments: unknown;
    }
  | {
      type: "checkpoint";
      coworkerId: string;
      taskId: string;
      messages: unknown[];
      pendingTool?: unknown;
    }
  | {
      type: "run.completed";
      coworkerId: string;
      taskId: string;
      runId: string;
      result: string;
      waitingForApproval: boolean;
    }
  | {
      type: "run.failed";
      coworkerId: string;
      taskId: string;
      runId: string;
      error: string;
    };
