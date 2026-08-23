import { parentPort } from "node:worker_threads";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  InMemoryCredentialStore,
  Type,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { getToolCatalogEntry } from "@shared/tool-catalog";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type {
  MainToWorkerMessage,
  WorkerCoworkerConfig,
  WorkerToMainMessage,
} from "./protocol";
import { toProviderToolName } from "./tool-names";

if (!parentPort) throw new Error("Coworker worker must run inside a worker thread");

interface ActiveRun {
  taskId: string;
  runId: string;
  threadId: string;
  resultText: string;
  assistantMessageId: string | null;
  approval: {
    approvalId: string;
    summary: string;
    toolCallId: string;
    toolName: string;
  } | null;
}

let config: WorkerCoworkerConfig | null = null;
let agent: Agent | null = null;
let models: MutableModels | null = null;
let demo: ReturnType<typeof fauxProvider> | null = null;
let activeRun: ActiveRun | null = null;
let imageInputSupported = false;
const controlledToolNamesByProviderName = new Map<string, string>();

const pendingToolResponses = new Map<
  string,
  (response: Extract<MainToWorkerMessage, { type: "tool.response" }>["response"]) => void
>();

function post(message: WorkerToMainMessage): void {
  parentPort!.postMessage(message);
}

function emit(event: BaseEvent): void {
  if (!config || !activeRun) return;
  post({
    type: "agui.event",
    coworkerId: config.coworker.id,
    taskId: activeRun.taskId,
    runId: activeRun.runId,
    event,
  });
}

function checkpointActiveRun(): void {
  if (!config || !activeRun || !agent) return;
  post({
    type: "checkpoint",
    coworkerId: config.coworker.id,
    taskId: activeRun.taskId,
    messages: agent.state.messages,
    pendingTool: activeRun.approval,
  });
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .map((part) => {
      if (typeof part !== "object" || part === null) return "";
      if ("text" in part && typeof part.text === "string") return part.text;
      return "";
    })
    .join("");
}

function toolResultText(result: unknown): string {
  if (typeof result !== "object" || result === null || !("content" in result)) {
    return JSON.stringify(result);
  }
  return textFromContent(result.content);
}

const parameterSchemas: Record<string, ReturnType<typeof Type.Object>> = {
  "files.list": Type.Object({
    path: Type.Optional(Type.String({ description: "Relative directory path; use . for the root" })),
  }),
  "files.read": Type.Object({
    path: Type.String({ description: "Relative file path inside the coworker workspace" }),
  }),
  "files.write": Type.Object({
    path: Type.String({ description: "Relative destination path inside the coworker workspace" }),
    content: Type.String({ description: "UTF-8 file contents" }),
  }),
  "invoice.create": Type.Object({
    client: Type.String(),
    recipientEmail: Type.Optional(Type.String()),
    lineItems: Type.Array(
      Type.Object({
        description: Type.String(),
        quantity: Type.Number(),
        rate: Type.Number(),
      }),
    ),
    dueDays: Type.Optional(Type.Number()),
    currency: Type.Optional(Type.String()),
  }),
  "documents.export": Type.Object({
    sourcePath: Type.String({
      description: "Relative path to an existing Markdown or plain-text workspace file",
    }),
    formats: Type.Array(
      Type.Union([Type.Literal("pdf"), Type.Literal("docx")]),
      {
        description: "One or both output formats",
        minItems: 1,
        maxItems: 2,
        uniqueItems: true,
      },
    ),
  }),
  "email.create_draft": Type.Object({
    to: Type.Union([Type.String(), Type.Array(Type.String())]),
    subject: Type.String(),
    body: Type.String(),
    attachments: Type.Optional(Type.Array(Type.String())),
  }),
  "email.send": Type.Object({
    to: Type.Union([Type.String(), Type.Array(Type.String())]),
    subject: Type.String(),
    body: Type.String(),
    attachments: Type.Optional(Type.Array(Type.String())),
  }),
};

function createProxyTool(controlledName: string, providerName: string): AgentTool<any> {
  return {
    name: providerName,
    label: controlledName,
    description:
      getToolCatalogEntry(controlledName)?.description ??
      `Execute the controlled ${controlledName} coworker tool.`,
    parameters: parameterSchemas[controlledName] ?? Type.Object({}),
    executionMode: "sequential",
    execute: async (toolCallId, params) => {
      if (!config || !activeRun) throw new Error("No task is active");
      const response = await new Promise<
        Extract<MainToWorkerMessage, { type: "tool.response" }>["response"]
      >((resolve) => {
        pendingToolResponses.set(toolCallId, resolve);
        post({
          type: "tool.request",
          coworkerId: config!.coworker.id,
          taskId: activeRun!.taskId,
          runId: activeRun!.runId,
          requestId: toolCallId,
          toolCallId,
          toolName: controlledName,
          arguments: params,
        });
      });
      if (response.kind === "denied") {
        return {
          content: [{ type: "text", text: `Tool denied: ${response.reason}` }],
          details: response,
        };
      }
      if (response.kind === "approval") {
        activeRun.approval = {
          approvalId: response.approvalId,
          summary: response.summary,
          toolCallId: response.toolCallId,
          toolName: controlledName,
        };
        return {
          content: [
            {
              type: "text",
              text: `Approval required before ${controlledName} can run. The task is safely paused.`,
            },
          ],
          details: response,
          terminate: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(response.result) }],
        details: response.result,
      };
    },
  };
}

function restoreMessages(messages: unknown[]): AgentMessage[] {
  return messages.filter(
    (message): message is AgentMessage =>
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      ["user", "assistant", "toolResult"].includes(String(message.role)),
  );
}

function durableHistory(messages: unknown[]): string {
  const lines = messages.flatMap((message) => {
    if (typeof message !== "object" || message === null) return [];
    if (!("role" in message) || !("content" in message)) return [];
    const role = String(message.role);
    if (!["user", "assistant"].includes(role) || typeof message.content !== "string") return [];
    return [`${role === "user" ? "User" : "Coworker"}: ${message.content}`];
  });
  return lines.join("\n\n").slice(-20_000);
}

async function initialize(workerConfig: WorkerCoworkerConfig): Promise<void> {
  config = workerConfig;
  const credentials = new InMemoryCredentialStore();
  if (workerConfig.modelApiKey) {
    await credentials.modify(workerConfig.coworker.modelProvider, async () => ({
      type: "api_key",
      key: workerConfig.modelApiKey,
    }));
  }
  models = createModels({ credentials });

  let model;
  if (workerConfig.coworker.modelProvider === "demo") {
    demo = fauxProvider({ tokensPerSecond: 80 });
    models.setProvider(demo.provider);
    model = demo.getModel();
  } else {
    const provider =
      workerConfig.coworker.modelProvider === "anthropic"
        ? anthropicProvider()
        : workerConfig.coworker.modelProvider === "openai"
          ? openaiProvider()
          : workerConfig.coworker.modelProvider === "google"
            ? googleProvider()
            : null;
    if (!provider) {
      throw new Error(`Unsupported model provider: ${workerConfig.coworker.modelProvider}`);
    }
    models.setProvider(provider);
    model = models.getModel(workerConfig.coworker.modelProvider, workerConfig.coworker.modelName);
    if (!model) {
      throw new Error(
        `Model ${workerConfig.coworker.modelName} is not available from ${workerConfig.coworker.modelProvider}`,
      );
    }
  }

  imageInputSupported = model.input.includes("image");
  const history = durableHistory(workerConfig.recentMessages);
  controlledToolNamesByProviderName.clear();
  const usePortableToolNames = workerConfig.coworker.modelProvider !== "demo";
  const tools = workerConfig.coworker.enabledTools.map((controlledName) => {
    const providerName = usePortableToolNames
      ? toProviderToolName(controlledName)
      : controlledName;
    const existing = controlledToolNamesByProviderName.get(providerName);
    if (existing && existing !== controlledName) {
      throw new Error(
        `Controlled tools ${existing} and ${controlledName} map to the same provider tool name`,
      );
    }
    controlledToolNamesByProviderName.set(providerName, controlledName);
    return createProxyTool(controlledName, providerName);
  });
  agent = new Agent({
    initialState: {
      systemPrompt: history
        ? `${workerConfig.coworker.systemPrompt}\n\nRecent durable conversation history:\n${history}`
        : workerConfig.coworker.systemPrompt,
      model,
      tools,
      messages: [],
    },
    streamFn: models.streamSimple.bind(models),
    sessionId: workerConfig.coworker.id,
    toolExecution: "sequential",
  });
  agent.subscribe(handleAgentEvent);
  post({ type: "ready", coworkerId: workerConfig.coworker.id });
}

function parseInvoicePrompt(input: string): {
  client: string;
  email: string;
  hours: number;
  rate: number;
  dueDays: number;
} {
  const client =
    input.match(/invoice\s+(?:for|to)\s+(.+?)(?:\s+for\s+\d|,|\.|$)/i)?.[1]?.trim() ?? "Client";
  const email = input.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0] ?? "billing@example.test";
  const hours = Number(input.match(/(\d+(?:\.\d+)?)\s*hours?/i)?.[1] ?? 1);
  const rate = Number(
    input.match(/(?:\$|USD\s*)(\d+(?:\.\d+)?)\s*(?:\/|per\s*)hour/i)?.[1] ?? 150,
  );
  const dueDays = Number(input.match(/due\s+(?:in\s+)?(\d+)\s+days?/i)?.[1] ?? 14);
  return { client, email, hours, rate, dueDays };
}

function lastToolDetails(context: Context, toolName: string): unknown {
  const message = [...context.messages]
    .reverse()
    .find((item) => item.role === "toolResult" && item.toolName === toolName);
  return message?.role === "toolResult" ? message.details : null;
}

function configureDemoResponses(input: string, resume: boolean): void {
  if (!demo || !activeRun) return;
  if (resume) {
    demo.setResponses([
      fauxAssistantMessage(
        "The approval decision has been applied and the task is complete. I recorded the outcome in the activity history.",
      ),
    ]);
    return;
  }
  if (/invoice/i.test(input)) {
    const invoice = parseInvoicePrompt(input);
    demo.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "invoice.create",
          {
            client: invoice.client,
            recipientEmail: invoice.email,
            lineItems: [
              {
                description: "Professional services",
                quantity: invoice.hours,
                rate: invoice.rate,
              },
            ],
            dueDays: invoice.dueDays,
            currency: "USD",
          },
          { id: `${activeRun.taskId}:invoice` },
        ),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const details = lastToolDetails(context, "invoice.create") as
          | { path?: string; invoiceNumber?: string; total?: number }
          | null;
        const invoiceNumber = details?.invoiceNumber ?? "Invoice";
        return fauxAssistantMessage(
          fauxToolCall(
            "email.send",
            {
              to: invoice.email,
              subject: `${invoiceNumber} for ${invoice.client}`,
              body: `Hello ${invoice.client},\n\nPlease find your invoice attached. Payment is due in ${invoice.dueDays} days.\n\nThank you.`,
              attachments: details?.path ? [details.path] : [],
            },
            { id: `${activeRun!.taskId}:send` },
          ),
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage("The invoice was created and sent successfully."),
    ]);
    return;
  }
  if (/report|follow[- ]?up|lead/i.test(input)) {
    demo.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "files.write",
          {
            path: `reports/${activeRun.taskId}.md`,
            content: `# Work summary\n\nTask: ${input}\n\n- Reviewed the available local context\n- Prepared the requested follow-up work\n- Recorded this report for review\n`,
          },
          { id: `${activeRun.taskId}:report` },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        "I finished the scheduled work and saved a structured report in my workspace.",
      ),
    ]);
    return;
  }
  demo.setResponses([
    fauxAssistantMessage(
      `I completed “${input}”. This demo coworker is running through the embedded Pi agent runtime; connect a model provider in Settings for open-ended reasoning.`,
    ),
  ]);
}

function handleAgentEvent(event: Parameters<Agent["subscribe"]>[0] extends (
  event: infer T,
  ...args: never[]
) => unknown
  ? T
  : never): void {
  if (!activeRun) return;
  if (event.type === "message_start" && event.message.role === "assistant") {
    activeRun.assistantMessageId = `${activeRun.runId}:assistant:${event.message.timestamp}`;
    emit({
      type: EventType.TEXT_MESSAGE_START,
      messageId: activeRun.assistantMessageId,
      role: "assistant",
      timestamp: Date.now(),
    });
    return;
  }
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta" && activeRun.assistantMessageId) {
      activeRun.resultText += update.delta;
      emit({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: activeRun.assistantMessageId,
        delta: update.delta,
        timestamp: Date.now(),
      });
    }
    return;
  }
  if (event.type === "message_end" && event.message.role === "assistant") {
    if (activeRun.assistantMessageId) {
      emit({
        type: EventType.TEXT_MESSAGE_END,
        messageId: activeRun.assistantMessageId,
        timestamp: Date.now(),
      });
    }
    activeRun.assistantMessageId = null;
    checkpointActiveRun();
    return;
  }
  if (event.type === "message_end" && event.message.role === "toolResult") {
    checkpointActiveRun();
    return;
  }
  if (event.type === "tool_execution_start") {
    emit({
      type: EventType.TOOL_CALL_START,
      toolCallId: event.toolCallId,
      toolCallName:
        controlledToolNamesByProviderName.get(event.toolName) ?? event.toolName,
      timestamp: Date.now(),
    });
    emit({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: event.toolCallId,
      delta: JSON.stringify(event.args),
      timestamp: Date.now(),
    });
    emit({
      type: EventType.TOOL_CALL_END,
      toolCallId: event.toolCallId,
      timestamp: Date.now(),
    });
    return;
  }
  if (event.type === "tool_execution_end") {
    emit({
      type: EventType.TOOL_CALL_RESULT,
      messageId: `${event.toolCallId}:result`,
      toolCallId: event.toolCallId,
      content: toolResultText(event.result),
      role: "tool",
      timestamp: Date.now(),
    });
  }
}

async function runTask(message: Extract<MainToWorkerMessage, { type: "run" }>): Promise<void> {
  if (!config || !agent) throw new Error("Worker has not been initialized");
  if (activeRun) throw new Error("This coworker already has an active task");
  activeRun = {
    taskId: message.taskId,
    runId: message.runId,
    threadId: message.threadId,
    resultText: "",
    assistantMessageId: null,
    approval: null,
  };
  try {
    if (message.checkpoint?.length) {
      agent.state.messages = restoreMessages(message.checkpoint);
    }
    configureDemoResponses(message.input, Boolean(message.resume));
    emit({
      type: EventType.RUN_STARTED,
      threadId: message.threadId,
      runId: message.runId,
      timestamp: Date.now(),
    });
    const prompt = message.resume
      ? `The human ${message.resume.decision} ${message.resume.toolName}. Result: ${JSON.stringify(
          message.resume.result,
        )}. Continue and finish the original task.`
      : message.input;
    const images = message.resume ? undefined : message.images;
    if (images?.length && !imageInputSupported) {
      throw new Error(
        `${config.coworker.modelName} does not support image input. Choose a vision-capable model in coworker settings.`,
      );
    }
    await agent.prompt(prompt, images);
    if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
    const finishedRun = activeRun;
    post({
      type: "checkpoint",
      coworkerId: config.coworker.id,
      taskId: message.taskId,
      messages: agent.state.messages,
      pendingTool: finishedRun.approval,
    });
    emit({
      type: EventType.RUN_FINISHED,
      threadId: message.threadId,
      runId: message.runId,
      result: finishedRun.resultText,
      outcome: finishedRun.approval
        ? {
            type: "interrupt",
            interrupts: [
              {
                id: finishedRun.approval.approvalId,
                reason: "approval_required",
                message: finishedRun.approval.summary,
                toolCallId: finishedRun.approval.toolCallId,
                metadata: { authoritativeStore: "sqlite" },
              },
            ],
          }
        : { type: "success" },
      timestamp: Date.now(),
    });
    post({
      type: "run.completed",
      coworkerId: config.coworker.id,
      taskId: message.taskId,
      runId: message.runId,
      result: finishedRun.resultText,
      waitingForApproval: Boolean(finishedRun.approval),
    });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    emit({
      type: EventType.RUN_ERROR,
      message: messageText,
      code: "PI_RUNTIME_ERROR",
      timestamp: Date.now(),
    });
    post({
      type: "run.failed",
      coworkerId: config.coworker.id,
      taskId: message.taskId,
      runId: message.runId,
      error: messageText,
    });
  } finally {
    activeRun = null;
  }
}

parentPort.on("message", (message: MainToWorkerMessage) => {
  void (async () => {
    if (message.type === "initialize") {
      await initialize(message.config);
      return;
    }
    if (message.type === "run") {
      await runTask(message);
      return;
    }
    if (message.type === "tool.response") {
      const resolve = pendingToolResponses.get(message.requestId);
      if (resolve) {
        pendingToolResponses.delete(message.requestId);
        resolve(message.response);
      }
      return;
    }
    if (message.type === "abort") {
      if (activeRun?.runId === message.runId) agent?.abort();
      return;
    }
    if (message.type === "shutdown") {
      agent?.abort();
      await agent?.waitForIdle().catch(() => undefined);
      process.exit(0);
    }
  })().catch((error) => {
    const messageText = error instanceof Error ? error.message : String(error);
    if (config && activeRun) {
      post({
        type: "run.failed",
        coworkerId: config.coworker.id,
        taskId: activeRun.taskId,
        runId: activeRun.runId,
        error: messageText,
      });
      activeRun = null;
    } else {
      throw error;
    }
  });
});
