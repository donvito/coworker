import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
import { isoWithLocalOffset } from "@shared/time";
import { formatModelSelectableSkills } from "@shared/pi-skill-prompt";
import {
  documentFormatClarification,
  documentFormatInstruction,
  hasExplicitDocumentFormat,
  requestsDocumentCreation,
} from "@shared/document-format";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type {
  MainToWorkerMessage,
  WorkerCoworkerConfig,
  WorkerToMainMessage,
} from "./protocol";
import { toProviderToolName } from "./tool-names";
import { createOpenAiCompatibleRuntimeProvider } from "./openai-compatible-provider";

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

// Model-transcript seam for the behavior evals. Those evals assert model
// judgment, so they run once against a real provider to capture its turns and
// replay them afterwards, rather than grading a scripted stand-in. Recording
// happens whenever a real provider runs with the path set; replay happens when
// the demo provider runs and the file already exists.
const modelTranscriptPath = process.env.COWORKER_MODEL_TRANSCRIPT || null;

interface RecordedTurn {
  /** Which pass over the task produced this turn. A resumed run continues the
   * pass it resumed; re-running a completed task starts a new one. */
  run: number;
  text: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  stopReason: string;
}

let recordedTurns: RecordedTurn[] = [];
let recordedTaskId: string | null = null;
let recordedRunIndex = 0;

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
  "skills.read": Type.Object({
    name: Type.String({ description: "Exact name of an enabled skill" }),
    path: Type.Optional(
      Type.String({
        description:
          "Relative packaged resource path. Omit to read skill.md and list available resources.",
      }),
    ),
  }),
  "web.search": Type.Object({
    query: Type.String({ description: "Focused web search query" }),
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
    provider: Type.Optional(
      Type.Union([
        Type.Literal("tavily"),
        Type.Literal("exa"),
        Type.Literal("firecrawl"),
        Type.Literal("serpapi"),
      ]),
    ),
  }),
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
    format: Type.Union([
      Type.Literal("pdf"),
      Type.Literal("docx"),
      Type.Literal("markdown"),
      Type.Literal("txt"),
    ], {
      description:
        "The output format explicitly selected by the user. This tool creates that final file directly; do not export it again.",
    }),
  }),
  "documents.export": Type.Object({
    sourcePath: Type.Optional(Type.String({
      description: "Relative path to an existing Markdown or plain-text workspace file",
    })),
    name: Type.Optional(Type.String({
      description: "Final document base name when creating directly from content",
    })),
    content: Type.Optional(Type.String({
      description:
        "Professionally structured Markdown document content to convert directly without creating an intermediate file. Use #/##/### headings, **bold labels**, lists, tables, and --- dividers as appropriate to the document type.",
    })),
    formats: Type.Array(
      Type.Union([
        Type.Literal("pdf"),
        Type.Literal("docx"),
        Type.Literal("xlsx"),
        Type.Literal("csv"),
      ]),
      {
        description:
          "One or more final output formats. For XLSX or CSV, content must include a Markdown table with a descriptive header row and one record per row. CSV supports exactly one table.",
        minItems: 1,
        maxItems: 4,
        uniqueItems: true,
      },
    ),
  }),
  "schedules.create": Type.Object({
    name: Type.String({ description: "Short human-readable schedule name" }),
    scheduleType: Type.Union([Type.Literal("cron"), Type.Literal("once")]),
    cronExpression: Type.Optional(
      Type.String({
        description:
          "Five-field cron expression for a recurring schedule, for example 0 9 * * 1 for Mondays at 09:00",
      }),
    ),
    runAt: Type.Optional(
      Type.String({
        description: "ISO 8601 date-time with an offset for a one-time future run",
      }),
    ),
    timezone: Type.Optional(
      Type.String({
        description: "IANA timezone such as America/New_York; omit to use the user's local timezone",
      }),
    ),
    taskTemplate: Type.Object({
      title: Type.String({ description: "Short title for each future task" }),
      input: Type.String({
        description:
          "The work the coworker should perform when the schedule runs. Do not mention creating or managing a schedule.",
      }),
      priority: Type.Optional(Type.Number()),
    }),
    enabled: Type.Optional(Type.Boolean()),
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
  const catalogDescription =
    getToolCatalogEntry(controlledName)?.description ??
    `Execute the controlled ${controlledName} coworker tool.`;
  const description =
    controlledName === "schedules.create"
      ? `${catalogDescription} Current time: ${isoWithLocalOffset()} (${
          Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
        }). Relative times such as "in 10 minutes" are relative to that instant, and runAt must be later than it.`
      : catalogDescription;
  return {
    name: providerName,
    label: controlledName,
    description,
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
  const runtimeModels = createModels({ credentials });
  models = runtimeModels;

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
            : workerConfig.coworker.modelProvider === "openrouter"
              ? openrouterProvider()
              : ["ollama", "lmstudio", "openai-compatible"].includes(
                    workerConfig.coworker.modelProvider,
                  ) && workerConfig.modelBaseUrl
                ? createOpenAiCompatibleRuntimeProvider({
                    provider: workerConfig.coworker.modelProvider as
                      | "ollama"
                      | "lmstudio"
                      | "openai-compatible",
                    modelId: workerConfig.coworker.modelName,
                    baseUrl: workerConfig.modelBaseUrl,
                    apiKey: workerConfig.modelApiKey,
                    supportsImages: workerConfig.modelSupportsImages ?? false,
                    contextWindow: workerConfig.modelContextWindow ?? 32_768,
                  })
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
  controlledToolNamesByProviderName.clear();
  const usePortableToolNames = workerConfig.coworker.modelProvider !== "demo";
  const skillToolNames = workerConfig.skills.length > 0 ? ["skills.read"] : [];
  if (workerConfig.skills.some((skill) => skill.name === "web-search")) {
    skillToolNames.push("web.search");
  }
  const enabledToolNames = [...new Set([...workerConfig.coworker.enabledTools, ...skillToolNames])];
  const tools = enabledToolNames.map((controlledName) => {
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
  const schedulingRule = workerConfig.coworker.enabledTools.includes("schedules.create")
    ? "Scheduling rule: For requests to schedule work, set a reminder, follow up later, or run something at a date or time, use schedules.create by default. Do not create an ICS, Markdown, or other file instead unless the user explicitly asks for a file export."
    : "";
  const skillsRule = formatModelSelectableSkills(workerConfig.skills);
  const recentSkillUses = workerConfig.recentSkillUses.length
    ? `Recent durable skill usage: ${[...new Set(workerConfig.recentSkillUses)].join(", ")}. When asked whether a skill was used, answer from this record and the current tool history.`
    : "";
  agent = new Agent({
    initialState: {
      systemPrompt: [
        workerConfig.coworker.systemPrompt,
        workerConfig.globalOperatingInstructions
          ? `Global operating instructions:\n${workerConfig.globalOperatingInstructions}`
          : "",
        documentFormatInstruction,
        "Final office file rule: invoice.create writes the selected final format directly. For a new PDF, Word, Excel, or CSV file, pass its content directly to documents.export with a name; do not create a temporary Markdown or text file first. You can create genuine XLSX and CSV files with documents.export, so never claim those formats are unavailable when that tool is enabled.",
        schedulingRule,
        skillsRule,
        recentSkillUses,
      ]
        .filter(Boolean)
        .join("\n\n"),
      model,
      tools,
      messages: [],
    },
    streamFn: (activeModel, context, options) =>
      runtimeModels.streamSimple(activeModel, context, {
        ...options,
        // Pi's provider default can wait up to ten minutes. A bounded timeout and
        // retry delay make an unavailable/rate-limited OpenRouter route fail visibly.
        timeoutMs: 90_000,
        maxRetries: 2,
        maxRetryDelayMs: 10_000,
      }),
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

function parseDemoSchedule(input: string): Record<string, unknown> {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const timeMatch = input.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  let hour = Number(timeMatch?.[1] ?? 9);
  const minute = Number(timeMatch?.[2] ?? 0);
  const meridiem = timeMatch?.[3]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;

  const taskInput =
    input.match(/\bto\s+(.+)$/i)?.[1]?.trim() ??
    input.match(/\bschedule\s+(.+?)\s+(?:every|tomorrow|in\s+\d+)/i)?.[1]?.trim() ??
    "Review the current workspace and complete the requested scheduled work.";
  const title = taskInput.length > 80 ? `${taskInput.slice(0, 77)}…` : taskInput;
  const base = {
    name: title,
    timezone,
    taskTemplate: { title, input: taskInput },
    enabled: true,
  };

  const relative = input.match(/\bin\s+(\d+)\s+(minute|hour|day)s?\b/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs =
      relative[2]?.toLowerCase() === "day"
        ? 86_400_000
        : relative[2]?.toLowerCase() === "hour"
          ? 3_600_000
          : 60_000;
    return {
      ...base,
      scheduleType: "once",
      runAt: new Date(Date.now() + amount * unitMs).toISOString(),
    };
  }

  if (/\btomorrow\b/i.test(input)) {
    const runAt = new Date();
    runAt.setDate(runAt.getDate() + 1);
    runAt.setHours(hour, minute, 0, 0);
    return { ...base, scheduleType: "once", runAt: runAt.toISOString() };
  }

  const dayNumbers: Record<string, number> = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };
  const day = Object.keys(dayNumbers).find((candidate) =>
    new RegExp(`\\bevery\\s+${candidate}\\b`, "i").test(input),
  );
  const dayField = /\bevery\s+weekday\b/i.test(input)
    ? "1-5"
    : day
      ? String(dayNumbers[day])
      : "*";
  return {
    ...base,
    scheduleType: "cron",
    cronExpression: `${minute} ${hour} * * ${dayField}`,
  };
}

function lastToolDetails(context: Context, toolName: string): unknown {
  const message = [...context.messages]
    .reverse()
    .find((item) => item.role === "toolResult" && item.toolName === toolName);
  return message?.role === "toolResult" ? message.details : null;
}

function recordAssistantTurn(message: { content: unknown; stopReason?: unknown }): void {
  if (!modelTranscriptPath || !config || config.coworker.modelProvider === "demo") return;
  const blocks = Array.isArray(message.content) ? message.content : [];
  const turn: RecordedTurn = {
    run: recordedRunIndex,
    text: blocks
      .filter((block): block is { type: "text"; text: string } => block?.type === "text")
      .map((block) => block.text)
      .join(""),
    toolCalls: blocks
      .filter(
        (block): block is {
          type: "toolCall";
          id: string;
          name: string;
          arguments: Record<string, unknown>;
        } => block?.type === "toolCall",
      )
      .map((block) => ({
        // Downstream tools derive identifiers from the tool-call id -- an
        // invoice number, for one -- and a later turn may reference the file
        // that produced. Replaying the original id keeps those agreeing.
        id: block.id,
        // Recordings are replayed through the controlled tool surface, so store
        // the portable name the gateway will receive rather than the provider's.
        name: controlledToolNamesByProviderName.get(block.name) ?? block.name,
        arguments: block.arguments,
      })),
    stopReason: typeof message.stopReason === "string" ? message.stopReason : "endTurn",
  };
  recordedTurns.push(turn);
  mkdirSync(dirname(modelTranscriptPath), { recursive: true });
  writeFileSync(
    modelTranscriptPath,
    `${JSON.stringify(
      {
        provider: config.coworker.modelProvider,
        model: config.coworker.modelName,
        recordedAt: new Date().toISOString(),
        turns: recordedTurns,
      },
      null,
      2,
    )}\n`,
  );
}

function replayRecordedTurns(resume: boolean): boolean {
  if (!demo || !activeRun || !modelTranscriptPath || !existsSync(modelTranscriptPath)) {
    return false;
  }
  // A resumed run continues consuming the same recording, so only prime the
  // provider when nothing is left over from the run that hit the approval.
  if (resume && demo.getPendingResponseCount() > 0) return true;
  let turns: RecordedTurn[];
  try {
    turns = JSON.parse(readFileSync(modelTranscriptPath, "utf8")).turns ?? [];
  } catch {
    return false;
  }
  if (turns.length === 0) return false;
  const passTurns = turns.filter((turn) => (turn.run ?? 0) === recordedRunIndex);
  if (passTurns.length === 0) {
    // The recording ended before this pass produced anything -- the live run
    // was torn down while it was still working. Complete without acting so the
    // state the recording captured is left intact.
    demo.setResponses([fauxAssistantMessage("Nothing further was required.")]);
    return true;
  }
  demo.setResponses(
    passTurns.map((turn, index) =>
      turn.toolCalls.length > 0
        ? fauxAssistantMessage(
            turn.toolCalls.map((call) =>
              fauxToolCall(call.name, call.arguments, {
                id: call.id || `${activeRun!.taskId}:replay:${index}:${call.name}`,
              }),
            ),
            { stopReason: "toolUse" },
          )
        : fauxAssistantMessage(turn.text),
    ),
  );
  return true;
}

function configureDemoResponses(input: string, resume: boolean): void {
  if (!demo || !activeRun) return;
  if (replayRecordedTurns(resume)) return;
  if (resume) {
    demo.setResponses([
      fauxAssistantMessage(
        "The approval decision has been applied and the task is complete. I recorded the outcome in the activity history.",
      ),
    ]);
    return;
  }
  if (requestsDocumentCreation(input) && !hasExplicitDocumentFormat(input)) {
    demo.setResponses([fauxAssistantMessage(documentFormatClarification)]);
    return;
  }
  if (
    /\b(?:schedule|remind)\b|\bevery\s+(?:day|weekday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\btomorrow\s+at\b/i.test(
      input,
    )
  ) {
    demo.setResponses([
      fauxAssistantMessage(
        fauxToolCall("schedules.create", parseDemoSchedule(input), {
          id: `${activeRun.taskId}:schedule`,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("The schedule is active and will create future tasks at the approved time."),
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
            format: /\bpdf\b/i.test(input)
              ? "pdf"
              : /\b(?:docx?|word)\b/i.test(input)
                ? "docx"
                : /\b(?:plain[- ]text|txt)\b/i.test(input)
                  ? "txt"
                  : "markdown",
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
    recordAssistantTurn(event.message);
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
    const controlledName =
      controlledToolNamesByProviderName.get(event.toolName) ?? event.toolName;
    emit({
      type: EventType.TOOL_CALL_START,
      toolCallId: event.toolCallId,
      toolCallName: controlledName,
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
    } else {
      agent.state.messages = [];
    }
    if (message.taskId !== recordedTaskId) {
      recordedTaskId = message.taskId;
      recordedTurns = [];
      recordedRunIndex = 0;
    } else if (!message.resume) {
      recordedRunIndex += 1;
    }
    configureDemoResponses(message.input, Boolean(message.resume));
    emit({
      type: EventType.RUN_STARTED,
      threadId: message.threadId,
      runId: message.runId,
      timestamp: Date.now(),
    });
    const basePrompt = message.resume
      ? `The human ${message.resume.decision} ${message.resume.toolName}. Result: ${JSON.stringify(
          message.resume.result,
        )}. Continue and finish the original task.`
      : message.input;
    const threadHistory = message.resume ? "" : durableHistory(message.threadMessages ?? []);
    const prompt = threadHistory
      ? `Recent durable history for this conversation only:\n${threadHistory}\n\nCurrent user request:\n${basePrompt}`
      : basePrompt;
    const images = message.resume ? undefined : message.images;
    if (images?.length && !imageInputSupported) {
      throw new Error(
        `${config.coworker.modelName} does not support image input. Choose a vision-capable model in coworker settings.`,
      );
    }
    await agent.prompt(prompt, images);
    if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
    const finishedRun = activeRun;
    if (!finishedRun.approval && !finishedRun.resultText.trim()) {
      throw new Error(
        `${config.coworker.modelName} completed without returning a text response. Try the request again or choose another model.`,
      );
    }
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
