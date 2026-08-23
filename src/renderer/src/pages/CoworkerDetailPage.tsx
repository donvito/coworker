import { useEffect, useMemo, useRef, useState } from "react";
import type { ImageInputContent, ToolMessage, UserMessage } from "@ag-ui/core";
import {
  UseAgentUpdate,
  useAgent,
  useRenderTool,
  useRenderToolCall,
} from "@copilotkit/react-core/v2/headless";
import { z } from "zod";
import type {
  Approval,
  Artifact,
  Coworker,
  Message as StoredMessage,
  Task,
  TaskImageAttachmentSummary,
} from "@shared/contracts";
import { IpcCoworkerAgent } from "../copilot/IpcCoworkerAgent";
import { LocalCopilotProvider } from "../copilot/LocalCopilotProvider";
import {
  ArtifactActions,
  artifactExtension,
  artifactKind,
  type ArtifactTarget,
} from "../components/ArtifactActions";
import { CoworkerSettingsModal } from "../components/CoworkerSettingsModal";
import { Icon } from "../components/Icon";
import {
  CoworkerModelBadge,
  StatusLabel,
  formatRelativeTime,
  initials,
} from "../components/Primitives";
import { CreateCoworkerModal } from "./CoworkersPage";

const invoiceSchema = z.object({
  client: z.string(),
  recipientEmail: z.string().optional(),
  lineItems: z.array(
    z.object({
      description: z.string(),
      quantity: z.number(),
      rate: z.number(),
    }),
  ),
  dueDays: z.number().optional(),
  currency: z.string().optional(),
});

const emailSchema = z.object({
  to: z.union([z.string(), z.array(z.string())]),
  subject: z.string(),
  body: z.string(),
  attachments: z.array(z.string()).optional(),
});

const fileSchema = z.object({ path: z.string(), content: z.string() });
const documentExportSchema = z.object({
  sourcePath: z.string(),
  formats: z.array(z.enum(["pdf", "docx"])),
});
const scheduleCreateSchema = z.object({
  name: z.string(),
  scheduleType: z.enum(["cron", "once"]),
  cronExpression: z.string().optional(),
  runAt: z.string().optional(),
  timezone: z.string().optional(),
  taskTemplate: z.object({
    title: z.string(),
    input: z.string(),
    priority: z.number().optional(),
  }),
  enabled: z.boolean().optional(),
});

const acceptedImageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const maxImageCount = 4;
const maxImageBytes = 8 * 1024 * 1024;
const maxImagesTotalBytes = 20 * 1024 * 1024;

interface PendingImage {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  data: string;
}

function fileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error(`Could not read ${file.name}`));
        return;
      }
      const comma = reader.result.indexOf(",");
      if (comma < 0) {
        reject(new Error(`Could not read ${file.name}`));
        return;
      }
      resolve(reader.result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

function textFromMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part
        ? [String(part.text)]
        : [],
    )
    .join("\n");
}

function imagesFromMessageContent(content: unknown): ImageInputContent[] {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (part): part is ImageInputContent =>
      Boolean(
        part &&
          typeof part === "object" &&
          "type" in part &&
          part.type === "image" &&
          "source" in part &&
          part.source &&
          typeof part.source === "object" &&
          "type" in part.source &&
          part.source.type === "data",
      ),
  );
}

function imagePartName(image: ImageInputContent, index: number): string {
  if (image.metadata && typeof image.metadata === "object" && "name" in image.metadata) {
    const name = image.metadata.name;
    if (typeof name === "string" && name.trim()) return name;
  }
  return `Attached image ${index + 1}`;
}

function PersistedMessageImages({
  attachments,
}: {
  attachments: TaskImageAttachmentSummary[];
}) {
  const [sources, setSources] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const attachmentKey = attachments.map((attachment) => attachment.id).join(":");

  useEffect(() => {
    let cancelled = false;
    setSources({});
    setFailed(new Set());
    void Promise.allSettled(
      attachments.map(async (attachment) => ({
        attachment,
        data: await window.coworker.imageAttachments.read(attachment.id),
      })),
    ).then((results) => {
      if (cancelled) return;
      const nextSources: Record<string, string> = {};
      const nextFailed = new Set<string>();
      for (const [index, result] of results.entries()) {
        const attachment = attachments[index];
        if (!attachment) continue;
        if (result.status === "fulfilled") {
          nextSources[attachment.id] =
            `data:${result.value.data.mimeType};base64,${result.value.data.data}`;
        } else {
          nextFailed.add(attachment.id);
        }
      }
      setSources(nextSources);
      setFailed(nextFailed);
    });
    return () => {
      cancelled = true;
    };
  }, [attachmentKey]);

  return (
    <div className={`workroom-message-images count-${Math.min(attachments.length, 4)}`}>
      {attachments.map((attachment) =>
        sources[attachment.id] ? (
          <img alt={attachment.name} key={attachment.id} src={sources[attachment.id]} />
        ) : (
          <span
            aria-label={
              failed.has(attachment.id)
                ? `${attachment.name} could not be loaded`
                : `Loading ${attachment.name}`
            }
            className={`workroom-message-image-placeholder${
              failed.has(attachment.id) ? " failed" : ""
            }`}
            key={attachment.id}
            role="img"
          >
            <Icon name={failed.has(attachment.id) ? "shield" : "file"} />
            <small>{failed.has(attachment.id) ? "Unavailable" : "Loading"}</small>
          </span>
        ),
      )}
    </div>
  );
}

export function CoworkerDetailPage({
  coworker,
  coworkers,
  tasks,
  approvals,
  artifacts,
  messages,
  imageAttachments,
  onBack,
  onChanged,
  onOpenApprovals,
  onRemoved,
  onSelectCoworker,
}: {
  coworker: Coworker;
  coworkers: Coworker[];
  tasks: Task[];
  approvals: Approval[];
  artifacts: Artifact[];
  messages: StoredMessage[];
  imageAttachments: TaskImageAttachmentSummary[];
  onBack: () => void;
  onChanged: () => Promise<void>;
  onOpenApprovals: () => void;
  onRemoved: () => void;
  onSelectCoworker: (coworker: Coworker) => void;
}) {
  const [managing, setManaging] = useState(false);
  const [creating, setCreating] = useState(false);
  const agent = useMemo(
    () =>
      new IpcCoworkerAgent(coworker.id, {
        agentId: coworker.id,
        description: `${coworker.name} · ${coworker.role}`,
        threadId: `coworker:${coworker.id}`,
        initialMessages: messages
          .filter((message) => message.role === "user" || message.role === "assistant")
          .map((message) => ({
            id: message.id,
            role: message.role as "user" | "assistant",
            content: message.content,
          })),
      }),
    [coworker.id],
  );

  return (
    <>
      <LocalCopilotProvider agentId={coworker.id} agent={agent}>
        <CoworkerSurface
          coworker={coworker}
          coworkers={coworkers}
          tasks={tasks}
          approvals={approvals}
          artifacts={artifacts}
          storedMessages={messages}
          imageAttachments={imageAttachments}
          onBack={onBack}
          onChanged={onChanged}
          onCreate={() => setCreating(true)}
          onManage={() => setManaging(true)}
          onOpenApprovals={onOpenApprovals}
          onSelectCoworker={onSelectCoworker}
        />
      </LocalCopilotProvider>
      {managing ? (
        <CoworkerSettingsModal
          coworker={coworker}
          onChanged={onChanged}
          onClose={() => setManaging(false)}
          onRemoved={onRemoved}
        />
      ) : null}
      {creating ? (
        <CreateCoworkerModal
          onChanged={onChanged}
          onClose={() => setCreating(false)}
          onCreated={onSelectCoworker}
        />
      ) : null}
    </>
  );
}

function CoworkerSurface({
  coworker,
  coworkers,
  tasks,
  approvals,
  artifacts,
  storedMessages,
  imageAttachments,
  onBack,
  onChanged,
  onCreate,
  onManage,
  onOpenApprovals,
  onSelectCoworker,
}: {
  coworker: Coworker;
  coworkers: Coworker[];
  tasks: Task[];
  approvals: Approval[];
  artifacts: Artifact[];
  storedMessages: StoredMessage[];
  imageAttachments: TaskImageAttachmentSummary[];
  onBack: () => void;
  onChanged: () => Promise<void>;
  onCreate: () => void;
  onManage: () => void;
  onOpenApprovals: () => void;
  onSelectCoworker: (coworker: Coworker) => void;
}) {
  const { agent, isReady } = useAgent({
    agentId: coworker.id,
    updates: [
      UseAgentUpdate.OnMessagesChanged,
      UseAgentUpdate.OnRunStatusChanged,
      UseAgentUpdate.OnStateChanged,
    ],
    throttleMs: 24,
  });
  const coworkerTasks = tasks.filter((task) => task.coworkerId === coworker.id);
  const activeTask = coworkerTasks.find((task) =>
    ["RUNNING", "WAITING_FOR_APPROVAL"].includes(task.status),
  );
  const pending = approvals.filter((approval) => approval.status === "PENDING");
  const renderToolCall = useRenderToolCall();
  const [draft, setDraft] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [readingImages, setReadingImages] = useState(false);
  const [supportsImageInput, setSupportsImageInput] = useState<boolean | null>(null);
  const [search, setSearch] = useState("");
  const [approvalInFlight, setApprovalInFlight] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [rightRailTab, setRightRailTab] = useState<"files" | "approvals">(
    pending.length > 0 ? "approvals" : "files",
  );
  const transcriptRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const messageTimes = useMemo(
    () => new Map(storedMessages.map((message) => [message.id, message.createdAt])),
    [storedMessages],
  );
  const storedMessagesById = useMemo(
    () => new Map(storedMessages.map((message) => [message.id, message])),
    [storedMessages],
  );
  const imageAttachmentsByTask = useMemo(() => {
    const grouped = new Map<string, TaskImageAttachmentSummary[]>();
    for (const attachment of imageAttachments) {
      const current = grouped.get(attachment.taskId) ?? [];
      current.push(attachment);
      grouped.set(attachment.taskId, current);
    }
    return grouped;
  }, [imageAttachments]);
  const visibleCoworkers = coworkers.filter((item) => {
    const query = search.trim().toLowerCase();
    return (
      !query ||
      `${item.name} ${item.role} ${item.modelProvider} ${item.modelName}`
        .toLowerCase()
        .includes(query)
    );
  });
  const sortedArtifacts = [...artifacts].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
  const tasksById = new Map(tasks.map((task) => [task.id, task]));

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [agent.messages.length, agent.isRunning]);

  useEffect(() => {
    let cancelled = false;
    setSupportsImageInput(null);
    void window.coworker.integrations
      .modelCapabilities(coworker.modelProvider, coworker.modelName)
      .then((capabilities) => {
        if (cancelled) return;
        setSupportsImageInput(capabilities.supportsImages);
        if (!capabilities.supportsImages) {
          setPendingImages([]);
        }
      })
      .catch(() => {
        if (!cancelled) setSupportsImageInput(null);
      });
    return () => {
      cancelled = true;
    };
  }, [coworker.modelProvider, coworker.modelName]);

  useRenderTool({
    name: "invoice.create",
    parameters: invoiceSchema,
    render: ({ status, parameters, result }) => {
      const lineItems = parameters.lineItems ?? [];
      const artifactTarget = artifactTargetsFromResult(result)[0];
      const total = lineItems.reduce(
        (sum, lineItem) => sum + (lineItem.quantity ?? 0) * (lineItem.rate ?? 0),
        0,
      );
      const currency = parameters.currency || "USD";
      return (
        <div className="invoice-document-card">
          <div className="invoice-document-head">
            <span>
              <small>Invoice draft</small>
              <strong>{parameters.client || "New invoice"}</strong>
            </span>
            <span className="invoice-state">
              {status === "complete" ? "Draft ready" : "Preparing"}
            </span>
          </div>
          <div className="invoice-document-body">
            <span>
              <small>Client</small>
              <strong>{parameters.client || "—"}</strong>
            </span>
            <span>
              <small>Description</small>
              <strong>
                {lineItems.map((lineItem) => lineItem.description).filter(Boolean).join(", ") ||
                  "Services"}
              </strong>
            </span>
            <span>
              <small>Quantity · rate</small>
              <strong>
                {lineItems.length
                  ? lineItems
                      .map(
                        (lineItem) =>
                          `${lineItem.quantity ?? 0} × ${formatMoney(lineItem.rate ?? 0, currency)}`,
                      )
                      .join(" · ")
                  : "—"}
              </strong>
            </span>
            <span className="invoice-total-row">
              <small>Total</small>
              <strong>{formatMoney(total, currency)}</strong>
            </span>
            <span>
              <small>Due</small>
              <strong>In {parameters.dueDays ?? 30} days</strong>
            </span>
          </div>
          <div className="invoice-document-foot">
            <Icon name="file" />
            <span>{result ? "Saved to the local workspace" : "Creating local invoice file…"}</span>
            {artifactTarget ? <ArtifactActions target={artifactTarget} /> : null}
          </div>
        </div>
      );
    },
  });
  useRenderTool({
    name: "email.send",
    parameters: emailSchema,
    render: ({ status, parameters }) => (
      <div className="tool-card approval-tool-card conversation-tool-card">
        <span className="tool-card-icon">
          <Icon name="shield" />
        </span>
        <span>
          <small>{status === "complete" ? "Email action recorded" : "Waiting for your approval"}</small>
          <strong>{parameters.subject || "Email"}</strong>
          <span>
            To {Array.isArray(parameters.to) ? parameters.to.join(", ") : parameters.to || "recipient"}
          </span>
        </span>
      </div>
    ),
  });
  useRenderTool({
    name: "files.write",
    parameters: fileSchema,
    render: ({ status, parameters, result }) => {
      const artifactTarget = artifactTargetsFromResult(result)[0];
      return (
        <div className="tool-card conversation-tool-card">
          <span className="tool-card-icon">
            <Icon name="file" />
          </span>
          <span>
            <small>{status === "complete" ? "File created" : "Writing file"}</small>
            <strong>{parameters.path || "Workspace file"}</strong>
            {artifactTarget ? <ArtifactActions target={artifactTarget} /> : null}
          </span>
        </div>
      );
    },
  });
  useRenderTool({
    name: "documents.export",
    parameters: documentExportSchema,
    render: ({ status, parameters, result }) => {
      const artifactTargets = artifactTargetsFromResult(result);
      return (
        <div className="tool-card conversation-tool-card">
          <span className="tool-card-icon">
            <Icon name="file" />
          </span>
          <span>
            <small>{status === "complete" ? "Document exported" : "Exporting document"}</small>
            <strong>
              {(parameters.formats ?? [])
                .map((format) => (format === "docx" ? "Word" : "PDF"))
                .join(" + ") || "Document"}
            </strong>
            <span>{parameters.sourcePath || "Workspace document"}</span>
            {artifactTargets.length > 0 ? (
              <span className="chat-exported-files">
                {artifactTargets.map((target) => (
                  <span className="chat-exported-file" key={target.id}>
                    <small>{target.name}</small>
                    <ArtifactActions target={target} />
                  </span>
                ))}
              </span>
            ) : null}
          </span>
        </div>
      );
    },
  });
  useRenderTool({
    name: "schedules.create",
    parameters: scheduleCreateSchema,
    render: ({ status, parameters }) => {
      const timing =
        parameters.scheduleType === "cron"
          ? parameters.cronExpression || "Recurring schedule"
          : parameters.runAt
            ? new Date(parameters.runAt).toLocaleString()
            : "One-time schedule";
      return (
        <div className="tool-card conversation-tool-card schedule-tool-card">
          <span className="tool-card-icon">
            <Icon name="clock" />
          </span>
          <span>
            <small>{status === "complete" ? "Schedule created" : "Schedule proposal"}</small>
            <strong>{parameters.name || "New schedule"}</strong>
            <span>
              {timing}
              {parameters.timezone ? ` · ${parameters.timezone}` : ""}
            </span>
            {parameters.taskTemplate?.input ? (
              <span className="schedule-tool-task">{parameters.taskTemplate.input}</span>
            ) : null}
          </span>
        </div>
      );
    },
  });

  async function attachImages(files: FileList | null) {
    if (!files?.length) return;
    setImageError(null);
    setReadingImages(true);
    try {
      const selected = [...files];
      if (pendingImages.length + selected.length > maxImageCount) {
        throw new Error(`Attach up to ${maxImageCount} images at a time.`);
      }
      for (const file of selected) {
        if (!acceptedImageTypes.has(file.type)) {
          throw new Error(`${file.name} is not a JPEG, PNG, WebP, or GIF image.`);
        }
        if (file.size === 0 || file.size > maxImageBytes) {
          throw new Error(`${file.name} must be 8 MB or smaller.`);
        }
      }
      const nextTotal =
        pendingImages.reduce((sum, image) => sum + image.size, 0) +
        selected.reduce((sum, file) => sum + file.size, 0);
      if (nextTotal > maxImagesTotalBytes) {
        throw new Error("Attached images must be 20 MB or smaller in total.");
      }
      const loaded = await Promise.all(
        selected.map(async (file) => ({
          id: crypto.randomUUID(),
          name: file.name,
          mimeType: file.type,
          size: file.size,
          data: await fileAsBase64(file),
        })),
      );
      setPendingImages((current) => [...current, ...loaded]);
    } catch (error) {
      setImageError(error instanceof Error ? error.message : String(error));
    } finally {
      setReadingImages(false);
      if (imageInputRef.current) imageInputRef.current.value = "";
    }
  }

  async function submitMessage(value: string) {
    const text = value.trim();
    if ((!text && pendingImages.length === 0) || !isReady || agent.isRunning || readingImages) return;
    const messageText = text || "Analyze the attached image.";
    const content: UserMessage["content"] =
      pendingImages.length > 0
        ? [
            { type: "text", text: messageText },
            ...pendingImages.map((image) => ({
              type: "image" as const,
              source: {
                type: "data" as const,
                value: image.data,
                mimeType: image.mimeType,
              },
              metadata: { name: image.name, size: image.size },
            })),
          ]
        : messageText;
    const previousMessages = [...agent.messages];
    const submittedDraft = draft;
    const submittedImages = pendingImages;
    setImageError(null);
    agent.addMessage({
      id: crypto.randomUUID(),
      role: "user",
      content,
    });
    setDraft("");
    setPendingImages([]);
    try {
      await agent.runAgent();
    } catch (error) {
      agent.setMessages(previousMessages);
      setDraft(submittedDraft);
      setPendingImages(submittedImages);
      setImageError(error instanceof Error ? error.message : String(error));
    }
  }

  async function approve(approval: Approval) {
    setApprovalInFlight(approval.id);
    setApprovalError(null);
    try {
      await window.coworker.approvals.decide({
        approvalId: approval.id,
        decision: "approve",
      });
      await onChanged();
    } catch (error) {
      setApprovalError(error instanceof Error ? error.message : String(error));
    } finally {
      setApprovalInFlight(null);
    }
  }

  return (
    <div className="coworker-detail conversation-layout">
      <div className="conversation-window-drag" />

      <aside className="conversation-roster-panel">
        <header className="conversation-roster-head">
          <h1>Coworkers</h1>
          <button className="conversation-icon-button" onClick={onCreate} aria-label="Create coworker">
            <Icon name="plus" />
          </button>
        </header>
        <label className="conversation-search">
          <Icon name="search" />
          <input
            aria-label="Search coworkers"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search"
            value={search}
          />
        </label>
        <nav className="conversation-roster" aria-label="Coworker conversations">
          {visibleCoworkers.map((item) => {
            const latestTask = tasks
              .filter((task) => task.coworkerId === item.id)
              .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
            const waiting = pending.filter((approval) => approval.coworkerId === item.id).length;
            return (
              <button
                aria-current={item.id === coworker.id ? "page" : undefined}
                className={
                  item.id === coworker.id
                    ? "conversation-roster-item selected"
                    : "conversation-roster-item"
                }
                key={item.id}
                onClick={() => onSelectCoworker(item)}
              >
                <span className="conversation-avatar">{initials(item.name)}</span>
                <span className="conversation-roster-copy">
                  <span>
                    <strong>{item.name}</strong>
                    <time>{latestTask ? formatRosterTime(latestTask.createdAt) : "New"}</time>
                  </span>
                  <span>
                    <small>
                      {latestTask?.title || item.description || `${item.role} is ready to help.`}
                    </small>
                    {waiting > 0 ? <b>{waiting}</b> : null}
                  </span>
                  <CoworkerModelBadge compact coworker={item} />
                </span>
              </button>
            );
          })}
          {visibleCoworkers.length === 0 ? (
            <p className="conversation-roster-empty">No coworkers match “{search}”.</p>
          ) : null}
        </nav>
        <button className="conversation-workroom-link" onClick={onBack}>
          <Icon name="home" />
          <span>Back to workroom</span>
        </button>
      </aside>

      <section className="conversation-main">
        <header className="conversation-main-head">
          <span className="conversation-avatar active">{initials(coworker.name)}</span>
          <span className="conversation-identity">
            <span>
              <strong>{coworker.name}</strong>
              <small>{coworker.role}</small>
              <CoworkerModelBadge compact coworker={coworker} />
            </span>
            <StatusLabel status={coworker.runtimeStatus} />
          </span>
          {activeTask ? (
            <div className="conversation-task-chip">
              <Icon name={activeTask.status === "WAITING_FOR_APPROVAL" ? "shield" : "activity"} />
              <span>
                <strong>{activeTask.title}</strong>
                <small>{activeTask.status.replaceAll("_", " ").toLowerCase()}</small>
              </span>
            </div>
          ) : coworkerTasks[0] ? (
            <div className="conversation-task-chip quiet">
              <Icon name="check" />
              <span>
                <strong>{coworkerTasks[0].title}</strong>
                <small>{formatRelativeTime(coworkerTasks[0].createdAt)}</small>
              </span>
            </div>
          ) : null}
          <button
            className="conversation-icon-button"
            onClick={onManage}
            aria-label={`Manage ${coworker.name}`}
          >
            <Icon name="more" />
          </button>
        </header>

        <div className="conversation-thread">
          {agent.messages.length === 0 ? (
            <div className="conversation-welcome">
              <span className="welcome-glyph">
                <Icon name="spark" />
              </span>
              <span className="eyebrow">Start a conversation</span>
              <h2>What should {coworker.name} take care of?</h2>
              <p>
                Give a clear outcome. Work stays local, controlled tools stay in the coworker
                workspace, and external actions pause for your approval.
              </p>
              <div className="prompt-examples">
                {coworker.name === "Ava" ? (
                  <>
                    <button
                      onClick={() =>
                        void submitMessage(
                          "Prepare an invoice for Acme Ltd for 12 hours at $150/hour, due in 14 days.",
                        )
                      }
                    >
                      Prepare the Acme invoice
                    </button>
                    <button
                      onClick={() => void submitMessage("Create a weekly receivables report.")}
                    >
                      Build a receivables report
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() =>
                        void submitMessage("Prepare follow-ups for overdue leads and save a report.")
                      }
                    >
                      Prepare overdue lead follow-ups
                    </button>
                    <button onClick={() => void submitMessage("Create today’s sales handoff report.")}>
                      Create a handoff report
                    </button>
                  </>
                )}
              </div>
            </div>
          ) : null}

          <div className="workroom-chat">
            <div className="workroom-messages" ref={transcriptRef}>
              {agent.messages.length > 0 ? (
                <div className="conversation-date-divider">
                  <span>Today</span>
                </div>
              ) : null}
              {agent.messages.map((message) => {
                if (message.role !== "user" && message.role !== "assistant") return null;
                const content = textFromMessageContent(message.content);
                const messageImages = imagesFromMessageContent(message.content);
                const storedMessage = storedMessagesById.get(message.id);
                const persistedImages =
                  messageImages.length === 0 && storedMessage?.role === "user" && storedMessage.taskId
                    ? (imageAttachmentsByTask.get(storedMessage.taskId) ?? [])
                    : [];
                const imageCount = messageImages.length + persistedImages.length;
                const toolCalls = message.role === "assistant" ? (message.toolCalls ?? []) : [];
                return (
                  <div
                    className={`workroom-turn workroom-turn-${message.role}`}
                    data-message-role={message.role}
                    key={message.id}
                  >
                    {content || imageCount > 0 ? (
                      <div
                        className={`workroom-bubble${imageCount > 0 ? " workroom-bubble-with-images" : ""}`}
                      >
                        {messageImages.length > 0 ? (
                          <div
                            className={`workroom-message-images count-${Math.min(messageImages.length, 4)}`}
                          >
                            {messageImages.map((image, index) => (
                              <img
                                alt={imagePartName(image, index)}
                                key={`${message.id}:image:${index}`}
                                src={
                                  image.source.type === "data"
                                    ? `data:${image.source.mimeType};base64,${image.source.value}`
                                    : image.source.value
                                }
                              />
                            ))}
                          </div>
                        ) : null}
                        {persistedImages.length > 0 ? (
                          <PersistedMessageImages attachments={persistedImages} />
                        ) : null}
                        {content ? <span className="workroom-message-text">{content}</span> : null}
                      </div>
                    ) : null}
                    {toolCalls.map((toolCall) => {
                      const toolMessage = agent.messages.find(
                        (candidate): candidate is ToolMessage =>
                          candidate.role === "tool" && candidate.toolCallId === toolCall.id,
                      );
                      return (
                        <div className="workroom-tool" key={toolCall.id}>
                          {renderToolCall({ toolCall, toolMessage }) ?? (
                            <div className="tool-card conversation-tool-card">
                              <span className="tool-card-icon">
                                <Icon name="settings" />
                              </span>
                              <span>
                                <small>{toolMessage ? "Tool complete" : "Using controlled tool"}</small>
                                <strong>{toolCall.function.name}</strong>
                              </span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {content || imageCount > 0 ? (
                      <small className="workroom-message-meta">
                        {message.role === "assistant" ? coworker.name : "You"} ·{" "}
                        {formatMessageTime(messageTimes.get(message.id))}
                      </small>
                    ) : null}
                  </div>
                );
              })}
              {agent.isRunning ? (
                <div className="workroom-running" aria-live="polite">
                  <span />
                  <span />
                  <span />
                  {coworker.name} is working
                </div>
              ) : null}
            </div>

            <form
              className="workroom-composer"
              onSubmit={(event) => {
                event.preventDefault();
                void submitMessage(draft);
              }}
            >
              {pendingImages.length > 0 ? (
                <div className="composer-image-tray" aria-label="Images ready to attach">
                  {pendingImages.map((image) => (
                    <figure className="composer-image-preview" key={image.id}>
                      <img
                        alt={image.name}
                        src={`data:${image.mimeType};base64,${image.data}`}
                      />
                      <figcaption>{image.name}</figcaption>
                      <button
                        aria-label={`Remove ${image.name}`}
                        onClick={() => {
                          setPendingImages((current) =>
                            current.filter((candidate) => candidate.id !== image.id),
                          );
                          setImageError(null);
                        }}
                        type="button"
                      >
                        ×
                      </button>
                    </figure>
                  ))}
                </div>
              ) : null}
              <input
                ref={imageInputRef}
                accept="image/jpeg,image/png,image/webp,image/gif"
                className="composer-file-input"
                disabled={
                  !isReady || agent.isRunning || readingImages || supportsImageInput === false
                }
                multiple
                onChange={(event) => void attachImages(event.target.files)}
                type="file"
              />
              <button
                className={`composer-add${pendingImages.length > 0 ? " active" : ""}`}
                disabled={
                  !isReady ||
                  agent.isRunning ||
                  readingImages ||
                  supportsImageInput === false ||
                  pendingImages.length >= maxImageCount
                }
                onClick={() => imageInputRef.current?.click()}
                title={
                  supportsImageInput === false
                    ? `${coworker.modelName} does not support image input`
                    : "Attach images"
                }
                type="button"
                aria-label="Attach images"
              >
                <Icon name="plus" />
              </button>
              <textarea
                aria-label={`Message ${coworker.name}`}
                disabled={!isReady || readingImages}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void submitMessage(draft);
                  }
                }}
                placeholder={isReady ? `Message ${coworker.name}…` : "Starting local runtime…"}
                rows={1}
                value={draft}
              />
              {agent.isRunning ? (
                <button
                  aria-label="Stop current task"
                  className="composer-send composer-stop"
                  onClick={() => agent.abortRun()}
                  type="button"
                >
                  <Icon name="stop" />
                </button>
              ) : (
                <button
                  aria-label="Send message"
                  className="composer-send"
                  disabled={
                    (!draft.trim() && pendingImages.length === 0) || !isReady || readingImages
                  }
                  type="submit"
                >
                  <Icon name="send" />
                </button>
              )}
              {imageError ? (
                <small className="composer-error" role="alert">
                  {imageError}
                </small>
              ) : supportsImageInput === false ? (
                <small className="composer-capability-note">
                  {coworker.modelName} does not accept images. Choose a model marked “image input”
                  in coworker settings.
                </small>
              ) : (
                <small>
                  {readingImages
                    ? "Preparing images…"
                    : `${coworker.name} can make mistakes. Review important actions.`}
                </small>
              )}
            </form>
          </div>
        </div>
      </section>

      <aside className="conversation-approval-rail conversation-right-rail">
        <header className="conversation-rail-tabs" role="tablist" aria-label="Coworker details">
          <button
            aria-controls="conversation-files-panel"
            aria-selected={rightRailTab === "files"}
            className={rightRailTab === "files" ? "active" : ""}
            id="conversation-files-tab"
            onClick={() => setRightRailTab("files")}
            role="tab"
            type="button"
          >
            <Icon name="file" />
            <span>Files</span>
            <b>{artifacts.length}</b>
          </button>
          <button
            aria-controls="conversation-approvals-panel"
            aria-selected={rightRailTab === "approvals"}
            className={rightRailTab === "approvals" ? "active" : ""}
            id="conversation-approvals-tab"
            onClick={() => setRightRailTab("approvals")}
            role="tab"
            type="button"
          >
            <Icon name="shield" />
            <span>Approvals</span>
            {pending.length > 0 ? <b className="attention">{pending.length}</b> : null}
          </button>
        </header>

        {rightRailTab === "files" ? (
          <section
            aria-labelledby="conversation-files-tab"
            className="conversation-file-rail"
            id="conversation-files-panel"
            role="tabpanel"
          >
            <header className="conversation-file-rail-head">
              <span>
                <strong>Files by {coworker.name}</strong>
                <small>Saved in this coworker’s local workspace</small>
              </span>
            </header>
            <div className="conversation-file-rail-list">
              {sortedArtifacts.length === 0 ? (
                <div className="conversation-file-empty">
                  <span>
                    <Icon name="file" />
                  </span>
                  <strong>No files yet</strong>
                  <small>Documents and drafts {coworker.name} creates will collect here.</small>
                </div>
              ) : (
                sortedArtifacts.map((artifact) => {
                  const sourceTask = artifact.taskId
                    ? tasksById.get(artifact.taskId)
                    : undefined;
                  return (
                    <article className="conversation-file-card" key={artifact.id}>
                      <span className="conversation-file-icon">
                        <Icon name="file" />
                        <small>{artifactExtension(artifact)}</small>
                      </span>
                      <div className="conversation-file-copy">
                        <strong title={artifact.name}>{artifact.name}</strong>
                        <small>
                          {artifactKind(artifact)} · {formatRelativeTime(artifact.createdAt)}
                        </small>
                        {sourceTask ? <p>{sourceTask.title}</p> : null}
                        <ArtifactActions
                          allowDelete
                          target={{ id: artifact.id, name: artifact.name }}
                        />
                      </div>
                    </article>
                  );
                })
              )}
            </div>
            {sortedArtifacts.length > 0 ? (
              <footer className="conversation-file-rail-foot">
                <Icon name="shield" />
                Stored locally · synced with the Files library
              </footer>
            ) : null}
          </section>
        ) : (
          <section
            aria-labelledby="conversation-approvals-tab"
            className="conversation-approvals-panel"
            id="conversation-approvals-panel"
            role="tabpanel"
          >
            <header className="conversation-approval-head">
              <span>
                <Icon name="check" />
                <strong>Waiting on you</strong>
                {pending.length > 0 ? <b>{pending.length}</b> : null}
              </span>
              <small>Shared inbox</small>
            </header>

            <div className="quick-approval-list">
              {pending.length === 0 ? (
                <div className="quick-approval-empty">
                  <span>
                    <Icon name="check" />
                  </span>
                  <strong>You’re all caught up</strong>
                  <small>Consequential actions will wait here for your decision.</small>
                </div>
              ) : (
                pending.slice(0, 4).map((approval) => {
                  const source = coworkers.find((item) => item.id === approval.coworkerId);
                  return (
                    <article className="quick-approval-card" key={approval.id}>
                      <div className="quick-approval-meta">
                        <span>{formatActionType(approval.actionType)}</span>
                        <small>{approval.riskLevel} risk</small>
                      </div>
                      <h3>{approval.summary}</h3>
                      <div className="quick-approval-details">
                        {approvalPreviewRows(approval).map(([label, value]) => (
                          <span key={label}>
                            <small>{label}</small>
                            <strong>{value}</strong>
                          </span>
                        ))}
                      </div>
                      <p>
                        From {source?.name ?? "coworker"} · {formatRelativeTime(approval.createdAt)}
                      </p>
                      <div className="quick-approval-actions">
                        <button
                          className="quick-approve-button"
                          disabled={approvalInFlight === approval.id}
                          onClick={() => void approve(approval)}
                        >
                          <Icon name="check" />
                          {approvalInFlight === approval.id ? "Approving…" : "Approve"}
                        </button>
                        <button className="quick-review-button" onClick={onOpenApprovals}>
                          Review
                        </button>
                      </div>
                    </article>
                  );
                })
              )}
            </div>

            {approvalError ? <div className="quick-approval-error">{approvalError}</div> : null}

            {approvals.some((approval) => approval.status !== "PENDING") ? (
              <section className="recently-cleared">
                <span className="eyebrow">Recently cleared</span>
                {approvals
                  .filter((approval) => approval.status !== "PENDING")
                  .slice(0, 4)
                  .map((approval) => (
                    <div key={approval.id}>
                      <Icon name={approval.status === "REJECTED" ? "stop" : "check"} />
                      <span>
                        <strong>{approval.summary}</strong>
                        <small>{approval.status.toLowerCase()}</small>
                      </span>
                    </div>
                  ))}
              </section>
            ) : null}

            <button className="open-approvals-button" onClick={onOpenApprovals}>
              Open all approvals
              <Icon name="arrow" />
            </button>
          </section>
        )}
      </aside>
    </div>
  );
}

function artifactTargetsFromResult(result: unknown): ArtifactTarget[] {
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];

  const record = value as Record<string, unknown>;
  const candidates =
    Array.isArray(record.files) && record.files.length > 0
      ? record.files
      : [record];
  const targets = candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const file = candidate as Record<string, unknown>;
    if (typeof file.artifactId !== "string") return [];
    const path = typeof file.path === "string" ? file.path : "";
    const name = path.split(/[\\/]/).filter(Boolean).at(-1);
    return [{ id: file.artifactId, name: name || "Created file" }];
  });
  return [...new Map(targets.map((target) => [target.id, target])).values()];
}

function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency.toUpperCase(),
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `$${value.toFixed(2)}`;
  }
}

function formatRosterTime(value: string): string {
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], { weekday: "short" });
}

function formatMessageTime(value: string | undefined): string {
  if (!value) return "Now";
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatActionType(actionType: string): string {
  return actionType
    .split(".")
    .map((part) => part.replaceAll("_", " "))
    .join(" · ");
}

function approvalPreviewRows(approval: Approval): Array<[string, string]> {
  const payload = approval.proposedPayload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [
      ["Action", formatActionType(approval.actionType)],
      ["Risk", approval.riskLevel],
    ];
  }

  const record = payload as Record<string, unknown>;
  const rows: Array<[string, string]> = [];
  if (typeof record.subject === "string") rows.push(["Subject", record.subject]);
  if (typeof record.to === "string") rows.push(["Recipient", record.to]);
  if (Array.isArray(record.to)) {
    rows.push(["Recipient", record.to.filter((value) => typeof value === "string").join(", ")]);
  }
  if (Array.isArray(record.attachments)) {
    rows.push([
      "Files",
      `${record.attachments.length} attachment${record.attachments.length === 1 ? "" : "s"}`,
    ]);
  }

  if (rows.length === 0) {
    let added = 0;
    for (const [key, value] of Object.entries(record)) {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        continue;
      }
      rows.push([
        key.replaceAll("_", " ").replace(/^\w/, (letter) => letter.toUpperCase()),
        String(value),
      ]);
      added += 1;
      if (added === 3) break;
    }
  }

  return rows.slice(0, 3);
}
