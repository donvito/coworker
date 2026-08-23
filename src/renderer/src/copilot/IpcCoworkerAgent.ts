import {
  AbstractAgent,
  EventType,
  type AgentCapabilities,
  type AgentConfig,
  type BaseEvent,
  type RunAgentInput,
} from "@ag-ui/client";
import { Observable } from "rxjs";

function compactImageHistory(input: RunAgentInput): RunAgentInput {
  let latestUserIndex = -1;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    if (input.messages[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  return {
    ...input,
    messages: input.messages.map((message, index) => {
      if (
        index === latestUserIndex ||
        message.role !== "user" ||
        !Array.isArray(message.content)
      ) {
        return message;
      }
      const content = message.content.filter((part) => part.type !== "image");
      return {
        ...message,
        content: content.length > 0 ? content : "[Image attached in an earlier message]",
      };
    }),
  };
}

export class IpcCoworkerAgent extends AbstractAgent {
  private activeRunId: string | null = null;

  constructor(
    readonly coworkerId: string,
    config: AgentConfig = {},
  ) {
    super({
      ...config,
      agentId: config.agentId ?? coworkerId,
      threadId: config.threadId ?? `coworker:${coworkerId}`,
      description: config.description ?? "Local Pi coworker",
    });
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      this.activeRunId = input.runId;
      const unsubscribe = window.coworker.events.subscribe((message) => {
        if (
          message.type !== "agent.event" ||
          message.coworkerId !== this.coworkerId ||
          message.runId !== input.runId
        ) {
          return;
        }
        subscriber.next(message.event);
        if (
          message.event.type === EventType.RUN_FINISHED ||
          message.event.type === EventType.RUN_ERROR
        ) {
          this.activeRunId = null;
          subscriber.complete();
        }
      });
      void window.coworker.agents
        .run({ coworkerId: this.coworkerId, input: compactImageHistory(input) })
        .catch((error) => {
          this.activeRunId = null;
          subscriber.error(error);
        });
      return () => unsubscribe();
    });
  }

  override abortRun(): void {
    if (this.activeRunId) {
      void window.coworker.agents.abort(this.coworkerId, this.activeRunId);
    }
    super.abortRun();
  }

  override clone(): IpcCoworkerAgent {
    return new IpcCoworkerAgent(this.coworkerId, {
      agentId: this.agentId,
      description: this.description,
      threadId: this.threadId,
      initialMessages: this.messages,
      initialState: this.state,
      debug: this.debug,
    });
  }

  override async getCapabilities(): Promise<AgentCapabilities> {
    return {
      identity: {
        name: this.description,
        type: "pi",
        provider: "local",
        version: "1",
      },
      transport: {
        streaming: true,
        websocket: false,
        httpBinary: false,
        pushNotifications: false,
        resumable: false,
      },
      tools: {
        supported: true,
        parallelCalls: false,
        clientProvided: false,
      },
      humanInTheLoop: {
        supported: true,
        approvals: true,
        interventions: false,
        feedback: false,
        interrupts: true,
        approveWithEdits: true,
      },
      execution: {
        codeExecution: false,
        sandboxed: false,
      },
      multimodal: {
        input: {
          image: true,
        },
      },
    };
  }
}
