import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { EventType, type ImageInputContent, type ToolMessage, type UserMessage } from "@ag-ui/core";
import {
  UseAgentUpdate,
  useAgent,
  useRenderTool,
  useRenderToolCall,
} from "@copilotkit/react-core/v2/headless";
import { z } from "zod";
import type {
  Approval,
  AppSettings,
  Artifact,
  Conversation,
  ConversationImageInput,
  Coworker,
  DiscussionSession,
  ModelEndpoint,
  Message as StoredMessage,
  Schedule,
  Task,
  TaskImageAttachmentSummary,
  Skill,
} from "@shared/contracts";
import { isDiscussionPass } from "@shared/discussion";
import { IpcCoworkerAgent } from "../copilot/IpcCoworkerAgent";
import { LocalCopilotProvider } from "../copilot/LocalCopilotProvider";
import { useAppData } from "../state/AppDataProvider";
import {
  ArtifactActions,
  artifactExtension,
  artifactKind,
  type ArtifactTarget,
} from "../components/ArtifactActions";
import { ComposerTools } from "../components/ComposerTools";
import { CoworkerSettingsModal } from "../components/CoworkerSettingsModal";
import { ChatMarkdown } from "../components/ChatMarkdown";
import { ModalPortal } from "../components/ModalPortal";
import { QuickModelSwitcher } from "../components/QuickModelSwitcher";
import { ScheduleEditorModal } from "../components/ScheduleEditorModal";
import { Icon } from "../components/Icon";
import { describeCronExpression, describeSchedule } from "@shared/schedule-frequency";
import {
  filterConversations,
  type LiveResponse,
  messageDayKey,
  messageDayLabel,
  updateLiveResponses,
} from "../lib/conversation-utils";
import {
  CopyTextButton,
  CoworkerAvatar,
  CoworkerModelBadge,
  StatusLabel,
  formatRelativeTime,
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
  format: z.enum(["pdf", "docx", "markdown", "txt"]).optional(),
});

const skillReadSchema = z.object({
  name: z.string(),
  path: z.string().optional(),
});

const emailSchema = z.object({
  to: z.union([z.string(), z.array(z.string())]),
  subject: z.string(),
  body: z.string(),
  attachments: z.array(z.string()).optional(),
});

const fileSchema = z.object({ path: z.string(), content: z.string() });
const documentExportSchema = z.object({
  sourcePath: z.string().optional(),
  name: z.string().optional(),
  content: z.string().optional(),
  formats: z.array(z.enum(["pdf", "docx", "xlsx", "csv"])),
});

const officeFormatLabel = {
  pdf: "PDF",
  docx: "Word",
  xlsx: "Excel",
  csv: "CSV",
} as const;
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

interface ApprovalEntry {
  approval: Approval;
  /** Timestamp for a day divider this approval must introduce, if any. */
  divider: string | null;
}

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds channel members mentioned in free-typed text so users don't have to
 * click a suggestion. Matches "@Full Name" case-insensitively, and "@First"
 * when the first name is unambiguous among members.
 */
export function mentionedCoworkerIdsInText(
  text: string,
  members: ReadonlyArray<Pick<Coworker, "id" | "name">>,
): string[] {
  const firstNameCounts = new Map<string, number>();
  for (const member of members) {
    const first = member.name.trim().split(/\s+/)[0]!.toLocaleLowerCase();
    firstNameCounts.set(first, (firstNameCounts.get(first) ?? 0) + 1);
  }
  return members
    .filter((member) => {
      const fullName = member.name.trim();
      const firstName = fullName.split(/\s+/)[0]!;
      const patterns =
        firstNameCounts.get(firstName.toLocaleLowerCase()) === 1
          ? [fullName, firstName]
          : [fullName];
      return patterns.some((name) =>
        new RegExp(`@${escapeRegExp(name)}(?!\\w)`, "i").test(text),
      );
    })
    .map((member) => member.id);
}

/**
 * A schedule with no conversation of its own posts into the coworker's default
 * thread, so name that explicitly rather than leaving it a mystery.
 */
export function scheduleDestination(
  schedule: Schedule,
  conversations: Conversation[],
  coworker: Coworker,
): string {
  if (!schedule.conversationId) return `Replies in ${coworker.name}’s main thread`;
  const conversation = conversations.find((item) => item.id === schedule.conversationId);
  if (!conversation) return `Replies in ${coworker.name}’s main thread`;
  return `Replies in ${conversationTitle(conversation, coworker)}`;
}

export function conversationTitle(
  conversation: Conversation | null,
  coworker: Coworker,
): string {
  if (!conversation) return `${coworker.name}’s main thread`;
  if (conversation.id === `coworker:${coworker.id}`) return `${coworker.name}’s main thread`;
  return conversation.title;
}

export function latestDirectConversation(
  conversations: Conversation[],
  coworkerId: string,
): Conversation | null {
  return conversations
    .filter(
      (conversation) =>
        conversation.kind === "direct" &&
        !conversation.archivedAt &&
        conversation.memberIds.includes(coworkerId),
    )
    .reduce<Conversation | null>(
      (latest, conversation) =>
        !latest || conversation.updatedAt > latest.updatedAt
          ? conversation
          : latest,
      null,
    );
}

const conversationRosterWidthKey = "conversation-roster-width";
const minConversationRosterWidth = 200;
const maxConversationRosterWidth = 340;

function clampConversationRosterWidth(value: number): number {
  return Math.min(maxConversationRosterWidth, Math.max(minConversationRosterWidth, value));
}

/**
 * User-adjustable width for the conversation roster sidebar, clamped to a
 * modest range and remembered across sessions. Null means the CSS default.
 */
function useConversationRosterWidth(): {
  rosterStyle: CSSProperties | undefined;
  resizeRoster: (width: number) => void;
  resetRoster: () => void;
} {
  const [width, setWidth] = useState<number | null>(() => {
    const stored = Number(window.localStorage.getItem(conversationRosterWidthKey));
    return Number.isFinite(stored) && stored > 0
      ? clampConversationRosterWidth(stored)
      : null;
  });
  return {
    rosterStyle:
      width === null
        ? undefined
        : ({ "--conversation-roster-width": `${width}px` } as CSSProperties),
    resizeRoster: (next: number) => {
      const clamped = clampConversationRosterWidth(next);
      setWidth(clamped);
      window.localStorage.setItem(conversationRosterWidthKey, String(clamped));
    },
    resetRoster: () => {
      setWidth(null);
      window.localStorage.removeItem(conversationRosterWidthKey);
    },
  };
}

function ConversationRosterResizeHandle({
  onResize,
  onReset,
}: {
  onResize: (width: number) => void;
  onReset: () => void;
}) {
  return (
    <div
      aria-hidden="true"
      className="conversation-roster-resize"
      onDoubleClick={onReset}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const handle = event.currentTarget;
        const panel = handle.parentElement;
        if (!panel) return;
        const startX = event.clientX;
        const startWidth = panel.getBoundingClientRect().width;
        handle.setPointerCapture(event.pointerId);
        const move = (moveEvent: PointerEvent) => {
          onResize(startWidth + (moveEvent.clientX - startX));
        };
        const stop = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", stop);
          handle.removeEventListener("pointercancel", stop);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", stop);
        handle.addEventListener("pointercancel", stop);
      }}
      title="Drag to resize · double-click to reset"
    />
  );
}

export function CoworkerDetailPage({
  coworker,
  coworkers,
  conversations,
  discussions,
  tasks,
  approvals,
  artifacts,
  messages,
  imageAttachments,
  schedules,
  skills,
  settings,
  modelEndpoints = [],
  initialConversationId = null,
  onBack,
  onChanged,
  onOpenApprovals,
  onOpenModelSettings,
  onRemoved,
  onSelectCoworker,
}: {
  coworker: Coworker;
  coworkers: Coworker[];
  conversations: Conversation[];
  discussions: DiscussionSession[];
  tasks: Task[];
  approvals: Approval[];
  artifacts: Artifact[];
  messages: StoredMessage[];
  imageAttachments: TaskImageAttachmentSummary[];
  schedules: Schedule[];
  skills: Skill[];
  settings: AppSettings;
  modelEndpoints?: ModelEndpoint[];
  initialConversationId?: string | null;
  onBack: () => void;
  onChanged: () => Promise<void>;
  onOpenApprovals: () => void;
  onOpenModelSettings?: () => void;
  onRemoved: () => void;
  onSelectCoworker: (coworker: Coworker) => void;
}) {
  const [managingCoworkerId, setManagingCoworkerId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [editingGroup, setEditingGroup] = useState<Conversation | null>(null);
  const [loadedConversationHistory, setLoadedConversationHistory] = useState<{
    conversationId: string;
    messages: StoredMessage[];
  } | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const managingCoworker =
    coworkers.find((candidate) => candidate.id === managingCoworkerId) ?? null;
  const latestConversation = latestDirectConversation(conversations, coworker.id);
  const [selectedConversationId, setSelectedConversationId] = useState(
    (initialConversationId &&
      conversations.some((conversation) => conversation.id === initialConversationId) &&
      initialConversationId) ||
      (latestConversation?.id ?? `coworker:${coworker.id}`),
  );
  const activeConversationId = selectedConversationId;
  // Filter by conversation id, not task binding: messages injected from
  // outside this surface (the Telegram bridge, and desktop-typed user
  // messages) are stored with taskId null and must still count below so the
  // open conversation reseeds when they arrive.
  const boundedConversationMessages = messages.filter(
    (message) => message.conversationId === activeConversationId,
  );
  const conversationHistoryReady =
    loadedConversationHistory?.conversationId === activeConversationId;
  // Stale-while-loading: while the next conversation's history is fetched,
  // keep rendering the one that is already loaded so switching never blanks
  // the page. The surface swaps in a single frame once the data arrives.
  const displayConversationId =
    loadedConversationHistory?.conversationId ?? activeConversationId;
  const displayConversation =
    conversations.find((conversation) => conversation.id === displayConversationId) ?? null;
  const conversationMessages =
    loadedConversationHistory?.messages ?? boundedConversationMessages;

  useEffect(() => {
    const next = latestDirectConversation(conversations, coworker.id);
    setSelectedConversationId(next?.id ?? `coworker:${coworker.id}`);
    // A different coworker must not show the previous coworker's thread while
    // its own history loads.
    setLoadedConversationHistory(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the coworker changes
  }, [coworker.id]);

  // Navigation from elsewhere (for example an activity entry) can point at a
  // specific conversation of this coworker.
  useEffect(() => {
    if (
      initialConversationId &&
      conversations.some((conversation) => conversation.id === initialConversationId)
    ) {
      setSelectedConversationId(initialConversationId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follow only explicit focus requests
  }, [initialConversationId]);

  useEffect(() => {
    let cancelled = false;
    void window.coworker.messages
      .listConversation(activeConversationId)
      .then((history) => {
        if (!cancelled) {
          setLoadedConversationHistory({
            conversationId: activeConversationId,
            messages: history,
          });
          setHistoryVersion((version) => version + 1);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoadedConversationHistory({
            conversationId: activeConversationId,
            messages: boundedConversationMessages,
          });
          setHistoryVersion((version) => version + 1);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [coworker.id, activeConversationId]);

  async function createConversation() {
    const conversation = await window.coworker.conversations.create({ coworkerId: coworker.id });
    setSelectedConversationId(conversation.id);
    await onChanged();
  }

  function openCoworkerConversation(target: Coworker) {
    if (target.id === coworker.id) {
      const directConversation = latestDirectConversation(
        conversations,
        target.id,
      );
      setSelectedConversationId(
        directConversation?.id ?? `coworker:${target.id}`,
      );
      return;
    }
    onSelectCoworker(target);
  }

  const agent = useMemo(
    () =>
      new IpcCoworkerAgent(coworker.id, {
        agentId: coworker.id,
        description: `${coworker.name} · ${coworker.role}`,
        threadId: displayConversationId,
        initialMessages: conversationMessages
          .filter((message) => message.role === "user" || message.role === "assistant")
          .map((message) => ({
            id: message.id,
            role: message.role as "user" | "assistant",
            content: message.content,
          })),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reseeded via historyVersion
    [coworker.id, displayConversationId, historyVersion],
  );

  // When a message arrives from Telegram into another conversation of this
  // coworker, follow it so the exchange stays on screen — unless a reply is
  // actively streaming in the current view.
  const { lastEvent } = useAppData();
  useEffect(() => {
    if (
      lastEvent?.type === "conversation.inbound" &&
      lastEvent.coworkerId === coworker.id &&
      lastEvent.conversationId !== selectedConversationId &&
      !agent.isStreaming
    ) {
      setSelectedConversationId(lastEvent.conversationId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to inbound events only
  }, [lastEvent]);

  // Background runs (Put someone to work, schedules, the Telegram bridge)
  // persist messages without streaming through this surface. When stored
  // messages outgrow what the agent is showing and nothing is streaming,
  // reload and reseed.
  const snapshotVisibleCount = boundedConversationMessages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  ).length;
  useEffect(() => {
    if (!conversationHistoryReady || agent.isStreaming) return;
    const agentVisibleCount = agent.messages.filter(
      (message) => message.role === "user" || message.role === "assistant",
    ).length;
    if (snapshotVisibleCount <= agentVisibleCount) return;
    let cancelled = false;
    void window.coworker.messages
      .listConversation(activeConversationId)
      .then((history) => {
        if (cancelled) return;
        setLoadedConversationHistory({
          conversationId: activeConversationId,
          messages: history,
        });
        setHistoryVersion((version) => version + 1);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [snapshotVisibleCount, conversationHistoryReady, activeConversationId, agent]);

  const historyLoadedOnce = loadedConversationHistory !== null;

  return (
    <>
      {historyLoadedOnce && displayConversation?.kind === "group" ? (
        <GroupConversationSurface
          approvals={approvals}
          conversation={displayConversation}
          conversations={conversations}
          coworkers={coworkers}
          discussions={discussions.filter(
            (discussion) => discussion.conversationId === displayConversation.id,
          )}
          imageAttachments={imageAttachments}
          messages={conversationMessages}
          modelEndpoints={modelEndpoints}
          onBack={onBack}
          onChanged={onChanged}
          onCreateGroup={() => setCreatingGroup(true)}
          onEditGroup={() => setEditingGroup(displayConversation)}
          onOpenApprovals={onOpenApprovals}
          onSelectConversation={setSelectedConversationId}
          onSelectCoworker={openCoworkerConversation}
          tasks={tasks}
        />
      ) : historyLoadedOnce ? (
        <LocalCopilotProvider
          agentId={coworker.id}
          agent={agent}
          key={`${coworker.id}:${displayConversationId}`}
        >
          <CoworkerSurface
            coworker={coworker}
            coworkers={coworkers}
            conversations={conversations}
            conversationId={displayConversationId}
            selectedConversation={displayConversation}
            tasks={tasks}
            approvals={approvals}
            artifacts={artifacts}
            allMessages={messages}
            storedMessages={conversationMessages}
            imageAttachments={imageAttachments}
            schedules={schedules}
            skills={skills}
            showReasoning={settings.showReasoning}
            modelEndpoints={modelEndpoints}
            onBack={onBack}
            onChanged={onChanged}
            onCreate={() => setCreating(true)}
            onCreateGroup={() => setCreatingGroup(true)}
            onManageCoworker={(target) => setManagingCoworkerId(target.id)}
            onNewConversation={createConversation}
            onOpenApprovals={onOpenApprovals}
            onSelectCoworker={openCoworkerConversation}
            onSelectConversation={setSelectedConversationId}
          />
        </LocalCopilotProvider>
      ) : (
        <div className="conversation-history-loading" aria-live="polite">
          <span className="workroom-running">
            <span />
            <span />
            <span />
          </span>
          Loading conversation…
        </div>
      )}
      {managingCoworker ? (
        <CoworkerSettingsModal
          coworker={managingCoworker}
          skills={skills}
          modelEndpoints={modelEndpoints}
          onChanged={onChanged}
          onClose={() => setManagingCoworkerId(null)}
          onOpenModelSettings={onOpenModelSettings}
          onRemoved={() => {
            setManagingCoworkerId(null);
            if (managingCoworker.id === coworker.id) onRemoved();
          }}
        />
      ) : null}
      {creating ? (
        <CreateCoworkerModal
          settings={settings}
          modelEndpoints={modelEndpoints}
          onChanged={onChanged}
          onClose={() => setCreating(false)}
          onCreated={onSelectCoworker}
          onOpenModelSettings={onOpenModelSettings}
        />
      ) : null}
      {creatingGroup ? (
        <CreateGroupChannelModal
          coworkers={coworkers}
          initialCoworkerId={coworker.id}
          onClose={() => setCreatingGroup(false)}
          onCreated={async (conversation) => {
            setCreatingGroup(false);
            setSelectedConversationId(conversation.id);
            await onChanged();
          }}
        />
      ) : null}
      {editingGroup ? (
        <CreateGroupChannelModal
          conversation={editingGroup}
          coworkers={coworkers}
          initialCoworkerId={coworker.id}
          onClose={() => setEditingGroup(null)}
          onCreated={async () => {
            setEditingGroup(null);
            await onChanged();
          }}
          onDeleted={async () => {
            setEditingGroup(null);
            setSelectedConversationId(`coworker:${coworker.id}`);
            await onChanged();
          }}
        />
      ) : null}
    </>
  );
}

function GroupConversationSurface({
  conversation,
  conversations,
  coworkers,
  discussions,
  messages,
  tasks,
  approvals,
  imageAttachments,
  modelEndpoints = [],
  onBack,
  onChanged,
  onCreateGroup,
  onEditGroup,
  onOpenApprovals,
  onSelectConversation,
  onSelectCoworker,
}: {
  conversation: Conversation;
  conversations: Conversation[];
  coworkers: Coworker[];
  discussions: DiscussionSession[];
  messages: StoredMessage[];
  tasks: Task[];
  approvals: Approval[];
  imageAttachments: TaskImageAttachmentSummary[];
  modelEndpoints?: ModelEndpoint[];
  onBack: () => void;
  onChanged: () => Promise<void>;
  onCreateGroup: () => void;
  onEditGroup: () => void;
  onOpenApprovals: () => void;
  onSelectConversation: (conversationId: string) => void;
  onSelectCoworker: (coworker: Coworker) => void;
}) {
  const members = conversation.memberIds.flatMap((id) => {
    const member = coworkers.find((candidate) => candidate.id === id);
    return member ? [member] : [];
  });
  const [draft, setDraft] = useState("");
  const [channelMessages, setChannelMessages] = useState(messages);
  const [highlightedSuggestion, setHighlightedSuggestion] = useState(0);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [liveResponses, setLiveResponses] = useState<Record<string, LiveResponse>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const { rosterStyle, resizeRoster, resetRoster } = useConversationRosterWidth();
  const transcript = useRef<HTMLDivElement>(null);
  const mentionMatch = draft.match(/(?:^|\s)@([^@\n]*)$/);
  const mentionQuery = mentionMatch?.[1]?.trim().toLocaleLowerCase() ?? null;
  const currentDiscussion = [...discussions]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .find((discussion) =>
      ["active", "awaiting_user", "failed"].includes(discussion.status),
    );
  const discussionOngoing =
    currentDiscussion?.status === "active" ||
    currentDiscussion?.status === "awaiting_user";
  const mentionedIds = mentionedCoworkerIdsInText(draft, members);
  const mentionSuggestions =
    mentionQuery === null || discussionOngoing
      ? []
      : members.filter(
          (member) =>
            !mentionedIds.includes(member.id) &&
            `${member.name} ${member.role}`.toLocaleLowerCase().includes(mentionQuery),
        );
  const channelTasks = tasks.filter((task) => task.threadId === conversation.id);
  const pendingApprovals = approvals.filter(
    (approval) =>
      approval.status === "PENDING" &&
      channelTasks.some((task) => task.id === approval.taskId),
  );
  useEffect(() => {
    setChannelMessages(messages);
  }, [conversation.id, messages]);

  useEffect(() => {
    return window.coworker.events.subscribe((event) => {
      if (event.type !== "agent.event" || event.conversationId !== conversation.id) return;
      setLiveResponses((current) => {
        if (event.event.type === EventType.RUN_FINISHED) {
          void Promise.all([
            onChanged(),
            window.coworker.messages.listConversation(conversation.id),
          ]).then(([, history]) => {
            setChannelMessages(history);
            setLiveResponses((latest) => {
              const next = { ...latest };
              delete next[event.runId];
              return next;
            });
          });
        }
        return updateLiveResponses(current, event);
      });
    });
  }, [conversation.id, onChanged]);

  useEffect(() => {
    transcript.current?.scrollTo({
      top: transcript.current.scrollHeight,
      behavior: "smooth",
    });
  }, [channelMessages.length, liveResponses]);

  async function attachGroupImages(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
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
    } catch (attachmentError) {
      setError(
        attachmentError instanceof Error ? attachmentError.message : String(attachmentError),
      );
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  function selectMention(member: Coworker) {
    const atIndex = draft.lastIndexOf("@");
    const prefix = atIndex >= 0 ? draft.slice(0, atIndex) : `${draft} `;
    setDraft(`${prefix}@${member.name} `);
    setHighlightedSuggestion(0);
  }

  async function submit() {
    const content = draft.trim();
    const activeMentionIds = discussionOngoing
      ? []
      : mentionedCoworkerIdsInText(content, members);
    if ((!content && pendingImages.length === 0) || submitting) return;
    if (discussionOngoing) {
      if (!content) {
        setError("Write a message to add to the discussion.");
        return;
      }
      if (pendingImages.length > 0) {
        setError("Images can be attached once the discussion has ended.");
        return;
      }
    }
    setSubmitting(true);
    setError(null);
    try {
      const receipt = await window.coworker.conversations.send({
        conversationId: conversation.id,
        clientMessageId: crypto.randomUUID(),
        content,
        mentionedCoworkerIds: activeMentionIds,
        images: pendingImages.map((image) => ({
          data: image.data,
          mimeType: image.mimeType as ConversationImageInput["mimeType"],
          name: image.name,
          size: image.size,
        })),
      });
      setLiveResponses((current) => ({
        ...current,
        ...Object.fromEntries(
          receipt.runs.map((run) => [
            run.runId,
            {
              coworkerId: run.coworkerId,
              taskId: run.taskId,
              content: "",
              status: "queued" as const,
            },
          ]),
        ),
      }));
      setDraft("");
      setPendingImages([]);
      setChannelMessages((current) =>
        current.some((message) => message.id === receipt.message.id)
          ? current
          : [...current, receipt.message],
      );
      await onChanged();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSubmitting(false);
    }
  }

  async function continueDiscussion() {
    if (!currentDiscussion || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const receipt = await window.coworker.conversations.continueDiscussion(
        currentDiscussion.id,
      );
      if (receipt.run) {
        setLiveResponses((current) => ({
          ...current,
          [receipt.run!.runId]: {
            coworkerId: receipt.run!.coworkerId,
            taskId: receipt.run!.taskId,
            content: "",
            status: "queued",
          },
        }));
      }
      await onChanged();
    } catch (continueError) {
      setError(
        continueError instanceof Error
          ? continueError.message
          : String(continueError),
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function stopDiscussion() {
    if (!currentDiscussion || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await window.coworker.conversations.stopDiscussion(
        currentDiscussion.id,
      );
      setLiveResponses({});
      await onChanged();
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : String(stopError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="coworker-detail conversation-layout channel-conversation-layout"
      style={rosterStyle}
    >
      <div className="conversation-window-drag" />
      <aside className="conversation-roster-panel">
        <ConversationRosterResizeHandle onReset={resetRoster} onResize={resizeRoster} />
        <header className="conversation-roster-head">
          <h1>Channels</h1>
          {/* Channel creation is hidden until group channels are ready. */}
        </header>
        <nav className="conversation-roster" aria-label="Channels and coworkers">
          {conversations
            .filter((item) => item.kind === "group" && !item.archivedAt)
            .map((item) => (
              <button
                aria-current={item.id === conversation.id ? "page" : undefined}
                className={
                  item.id === conversation.id
                    ? "conversation-roster-item selected"
                    : "conversation-roster-item"
                }
                key={item.id}
                onClick={() => onSelectConversation(item.id)}
                type="button"
              >
                <span className="conversation-avatar group-channel-avatar">
                  <Icon name="spark" />
                </span>
                <span className="conversation-roster-copy">
                  <strong>{item.title}</strong>
                  <small>{item.memberIds.length} coworkers</small>
                </span>
              </button>
            ))}
          {coworkers.map((item) => (
            <CoworkerRosterItem
              coworker={item}
              key={item.id}
              modelEndpoints={modelEndpoints}
              onOpenContextMenu={() => undefined}
              onSelect={() => onSelectCoworker(item)}
              selected={false}
              waiting={approvals.filter(
                (approval) =>
                  approval.coworkerId === item.id && approval.status === "PENDING",
              ).length}
            />
          ))}
        </nav>
        <button className="conversation-workroom-link" onClick={onBack}>
          <Icon name="home" />
          <span>Back to workspace</span>
        </button>
      </aside>

      <section className="conversation-main">
        <header className="conversation-main-head group-channel-head">
          <div className="conversation-head-profile">
            <span className="conversation-avatar group-channel-avatar active">
              <Icon name="people" />
            </span>
            <span className="conversation-identity">
              <strong>{conversation.title}</strong>
              <small>
                You · {members.map((member) => member.name).join(" · ")}
              </small>
            </span>
          </div>
          <span className="conversation-roster-actions">
            {pendingApprovals.length > 0 ? (
              <button className="conversation-history-trigger" onClick={onOpenApprovals}>
                <Icon name="shield" />
                {pendingApprovals.length} approval
                {pendingApprovals.length === 1 ? "" : "s"}
              </button>
            ) : null}
            <button
              aria-label="Edit channel members"
              className="conversation-icon-button"
              onClick={onEditGroup}
              type="button"
            >
              <Icon name="settings" />
            </button>
          </span>
        </header>

        <div className="conversation-thread">
          <div className="workroom-chat">
            <div className="workroom-messages" ref={transcript}>
              {channelMessages.length === 0 ? (
                <div className="conversation-welcome">
                  <span className="welcome-glyph">
                    <Icon name="people" />
                  </span>
                  <span className="eyebrow">Shared channel</span>
                  <h2>Talk to the room.</h2>
                  <p>
                    Messages reach every channel member unless you @mention
                    specific coworkers. They respond in turn with shared
                    context, pass when they have nothing to add, and wrap up on
                    their own — reply anytime to steer.
                  </p>
                </div>
              ) : null}
              {channelMessages.map((message) => {
                const author = message.coworkerId
                  ? coworkers.find((item) => item.id === message.coworkerId)
                  : null;
                const sourceTasks = tasks.filter(
                  (task) => task.sourceMessageId === message.id,
                );
                const sourceTaskIds = new Set(sourceTasks.map((task) => task.id));
                const attachments = imageAttachments.filter((attachment) =>
                  sourceTaskIds.has(attachment.taskId),
                );
                const uniqueAttachments = attachments.filter(
                  (attachment, index) =>
                    attachments.findIndex(
                      (candidate) =>
                        candidate.name === attachment.name &&
                        candidate.size === attachment.size,
                    ) === index,
                );
                if (message.role === "assistant" && isDiscussionPass(message.content)) {
                  return (
                    <div className="discussion-pass-note" key={message.id}>
                      {author ? (
                        <CoworkerAvatar className="discussion-pass-avatar" coworker={author} />
                      ) : null}
                      <span>{message.authorName} had nothing to add</span>
                    </div>
                  );
                }
                return (
                  <div
                    className={`workroom-turn workroom-turn-${message.role}`}
                    data-message-role={message.role}
                    key={message.id}
                  >
                    {author ? (
                      <CoworkerAvatar className="conversation-message-avatar" coworker={author} />
                    ) : null}
                    <div className="channel-message-stack">
                      <small className="channel-message-author">
                        {message.authorName}
                        <CopyTextButton text={message.content} />
                      </small>
                      <div className="workroom-bubble">
                        {uniqueAttachments.length > 0 ? (
                          <PersistedMessageImages attachments={uniqueAttachments} />
                        ) : null}
                        <ChatMarkdown>{message.content}</ChatMarkdown>
                      </div>
                    </div>
                  </div>
                );
              })}
              {Object.entries(liveResponses).map(([runId, response]) => {
                const member = coworkers.find((item) => item.id === response.coworkerId);
                if (isDiscussionPass(response.content)) {
                  return (
                    <div className="discussion-pass-note" key={runId}>
                      {member ? (
                        <CoworkerAvatar className="discussion-pass-avatar" coworker={member} />
                      ) : null}
                      <span>{member?.name ?? "Coworker"} had nothing to add</span>
                    </div>
                  );
                }
                return (
                  <div className="workroom-turn workroom-turn-assistant" key={runId}>
                    {member ? (
                      <CoworkerAvatar className="conversation-message-avatar" coworker={member} />
                    ) : null}
                    <div className="channel-message-stack">
                      <small className="channel-message-author">
                        {member?.name ?? "Coworker"}
                      </small>
                      <div className="workroom-bubble">
                        {response.content ? (
                          <ChatMarkdown>{response.content}</ChatMarkdown>
                        ) : response.status === "failed" ? (
                          <span>{response.error}</span>
                        ) : (
                          <span className="workroom-running">
                            <span />
                            <span />
                            <span />
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="conversation-composer channel-composer">
              {currentDiscussion ? (
                <div
                  className={`discussion-status discussion-${currentDiscussion.status}`}
                >
                  <span>
                    <Icon name="people" />
                    <span>
                      <strong>
                        {currentDiscussion.status === "active"
                          ? "Coworkers are discussing"
                          : currentDiscussion.status === "awaiting_user"
                            ? "Long discussion — checking in"
                            : "Discussion paused"}
                      </strong>
                      <small>
                        {currentDiscussion.status === "active"
                          ? `Turn ${currentDiscussion.nextTurn} — reply anytime to steer the discussion`
                          : currentDiscussion.status === "awaiting_user"
                            ? "Reply or continue if they should keep going, or end it here."
                            : currentDiscussion.error ?? "Start a new discussion when ready."}
                      </small>
                    </span>
                  </span>
                  <span className="discussion-status-actions">
                    {currentDiscussion.status === "awaiting_user" ? (
                      <button
                        className="primary-button"
                        disabled={submitting}
                        onClick={() => void continueDiscussion()}
                        type="button"
                      >
                        Continue discussion
                      </button>
                    ) : null}
                    {currentDiscussion.status !== "failed" ? (
                      <button
                        className="secondary-button"
                        disabled={submitting}
                        onClick={() => void stopDiscussion()}
                        type="button"
                      >
                        {currentDiscussion.status === "active" ? "Stop" : "End"}
                      </button>
                    ) : null}
                  </span>
                </div>
              ) : null}
              {mentionSuggestions.length > 0 ? (
                <div className="mention-suggestions" role="listbox">
                  {mentionSuggestions.map((member, index) => {
                    const highlighted =
                      index ===
                      Math.min(highlightedSuggestion, mentionSuggestions.length - 1);
                    return (
                      <button
                        aria-selected={highlighted}
                        className={highlighted ? "highlighted" : undefined}
                        key={member.id}
                        onClick={() => selectMention(member)}
                        onMouseEnter={() => setHighlightedSuggestion(index)}
                        role="option"
                        type="button"
                      >
                        <CoworkerAvatar className="mention-avatar" coworker={member} />
                        <span>
                          <strong>@{member.name}</strong>
                          <small>{member.role}</small>
                        </span>
                      </button>
                    );
                  })}
                  <small className="mention-suggestions-hint">
                    ↑↓ to choose · Enter or Tab to add
                  </small>
                </div>
              ) : null}
              {pendingImages.length > 0 ? (
                <div className="composer-image-list">
                  {pendingImages.map((image) => (
                    <button
                      key={image.id}
                      onClick={() =>
                        setPendingImages((current) =>
                          current.filter((candidate) => candidate.id !== image.id),
                        )
                      }
                      title={`Remove ${image.name}`}
                      type="button"
                    >
                      {image.name}
                    </button>
                  ))}
                </div>
              ) : null}
              <textarea
                aria-label="Message the channel"
                onChange={(event) => {
                  setDraft(event.target.value);
                  setHighlightedSuggestion(0);
                  setError(null);
                }}
                onKeyDown={(event) => {
                  if (mentionSuggestions.length > 0) {
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      const delta = event.key === "ArrowDown" ? 1 : -1;
                      setHighlightedSuggestion(
                        (current) =>
                          (current + delta + mentionSuggestions.length) %
                          mentionSuggestions.length,
                      );
                      return;
                    }
                    if (event.key === "Enter" || event.key === "Tab") {
                      event.preventDefault();
                      const choice =
                        mentionSuggestions[
                          Math.min(highlightedSuggestion, mentionSuggestions.length - 1)
                        ];
                      if (choice) selectMention(choice);
                      return;
                    }
                  }
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void submit();
                  }
                }}
                placeholder={
                  currentDiscussion?.status === "active"
                    ? "Add to the discussion — the next turn will see your message"
                    : currentDiscussion?.status === "awaiting_user"
                      ? "Reply to keep the discussion going…"
                      : "Message everyone, or @mention specific coworkers"
                }
                value={draft}
              />
              <input
                accept={[...acceptedImageTypes].join(",")}
                hidden
                multiple
                onChange={(event) => void attachGroupImages(event.target.files)}
                ref={fileInput}
                type="file"
              />
              <div className="channel-composer-actions">
                {!discussionOngoing ? (
                  <button
                    aria-label="Attach images"
                    className="conversation-icon-button"
                    title="Attach images"
                    onClick={() => fileInput.current?.click()}
                    type="button"
                  >
                    <Icon name="file" />
                  </button>
                ) : null}
                {Object.keys(liveResponses).length > 0 && !currentDiscussion ? (
                  <button
                    className="conversation-icon-button"
                    onClick={() => {
                      void Promise.all(
                        Object.values(liveResponses).map((response) =>
                          window.coworker.tasks.cancel(response.taskId),
                        ),
                      ).then(onChanged);
                    }}
                    title="Stop channel work"
                    type="button"
                  >
                    <Icon name="stop" />
                  </button>
                ) : null}
                <button
                  className="primary-button"
                  disabled={submitting}
                  onClick={() => void submit()}
                  type="button"
                >
                  <Icon name="send" />
                  {submitting ? "Sending…" : "Send"}
                </button>
              </div>
              {error ? (
                <small className="composer-error" role="alert">
                  {error}
                </small>
              ) : null}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

export function CreateGroupChannelModal({
  conversation,
  coworkers,
  initialCoworkerId,
  onClose,
  onCreated,
  onDeleted,
}: {
  conversation?: Conversation;
  coworkers: Coworker[];
  initialCoworkerId: string;
  onClose: () => void;
  onCreated: (conversation: Conversation) => Promise<void>;
  onDeleted?: () => Promise<void>;
}) {
  const [title, setTitle] = useState(conversation?.title ?? "");
  const [memberIds, setMemberIds] = useState<string[]>(
    conversation?.memberIds ?? [initialCoworkerId],
  );
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function removeChannel() {
    if (!conversation || saving) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await window.coworker.conversations.remove(conversation.id);
      await onDeleted?.();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError));
      setSaving(false);
      setConfirmingDelete(false);
    }
  }

  async function create() {
    if (memberIds.length < 2 || saving) {
      setError("Choose at least two coworkers for a group channel.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = conversation
        ? await window.coworker.conversations.update(conversation.id, {
            memberIds,
            title: title.trim() || conversation.title,
          })
        : await window.coworker.conversations.create({
            kind: "group",
            memberIds,
            title: title.trim() || undefined,
          });
      await onCreated(saved);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalPortal>
    <div className="modal-backdrop" onMouseDown={onClose} role="presentation">
      <form
        className="modal-card group-channel-modal"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <div>
          <span className="eyebrow">{conversation ? "Channel settings" : "New channel"}</span>
          <h2>{conversation ? "Update the channel" : "Choose the coworkers"}</h2>
          <p>You remain the owner and observer of every channel.</p>
        </div>
        <label>
          Channel name
          <input
            maxLength={160}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Launch planning"
            value={title}
          />
        </label>
        <fieldset className="group-member-picker">
          <legend>Coworkers</legend>
          {coworkers.map((coworker) => (
            <label key={coworker.id}>
              <input
                checked={memberIds.includes(coworker.id)}
                onChange={(event) =>
                  setMemberIds((current) =>
                    event.target.checked
                      ? [...new Set([...current, coworker.id])]
                      : current.filter((id) => id !== coworker.id),
                  )
                }
                type="checkbox"
              />
              <CoworkerAvatar className="mention-avatar" coworker={coworker} />
              <span>
                <strong>{coworker.name}</strong>
                <small>{coworker.role}</small>
              </span>
            </label>
          ))}
        </fieldset>
        {error ? <small className="form-error">{error}</small> : null}
        <div className="modal-actions">
          {conversation && onDeleted ? (
            <button
              className="secondary-button danger modal-delete-action"
              disabled={saving}
              onClick={() => void removeChannel()}
              type="button"
            >
              {confirmingDelete ? "Confirm delete" : "Delete channel"}
            </button>
          ) : null}
          <button className="secondary-button" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="primary-button" disabled={saving} type="submit">
            {saving
              ? conversation
                ? "Saving…"
                : "Creating…"
              : conversation
                ? "Save channel"
                : "Create channel"}
          </button>
        </div>
      </form>
    </div>
    </ModalPortal>
  );
}

export function CoworkerRosterItem({
  coworker,
  latestTask,
  waiting,
  selected,
  modelEndpoints = [],
  onSelect,
  onOpenContextMenu,
}: {
  coworker: Coworker;
  latestTask?: Task;
  waiting: number;
  selected: boolean;
  modelEndpoints?: ModelEndpoint[];
  onSelect: () => void;
  onOpenContextMenu: (position: { x: number; y: number }) => void;
}) {
  return (
    <button
      aria-current={selected ? "page" : undefined}
      className={selected ? "conversation-roster-item selected" : "conversation-roster-item"}
      onClick={onSelect}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenContextMenu({
          x: Math.min(event.clientX, window.innerWidth - 190),
          y: Math.min(event.clientY, window.innerHeight - 80),
        });
      }}
    >
      <CoworkerAvatar className="conversation-avatar" coworker={coworker} />
      <span className="conversation-roster-copy">
        <span>
          <strong>{coworker.name}</strong>
          <time>{latestTask ? formatRosterTime(latestTask.createdAt) : "New"}</time>
        </span>
        <span>
          <small>
            {latestTask?.title || coworker.description || `${coworker.role} is ready to help.`}
          </small>
          {waiting > 0 ? <b>{waiting}</b> : null}
        </span>
        <CoworkerModelBadge compact coworker={coworker} modelEndpoints={modelEndpoints} />
      </span>
    </button>
  );
}

function CoworkerSurface({
  coworker,
  coworkers,
  conversations,
  conversationId,
  selectedConversation,
  tasks,
  approvals,
  artifacts,
  allMessages,
  storedMessages,
  imageAttachments,
  schedules,
  skills,
  showReasoning,
  modelEndpoints = [],
  onBack,
  onChanged,
  onCreate,
  onCreateGroup,
  onManageCoworker,
  onNewConversation,
  onOpenApprovals,
  onSelectCoworker,
  onSelectConversation,
}: {
  coworker: Coworker;
  coworkers: Coworker[];
  conversations: Conversation[];
  conversationId: string;
  selectedConversation: Conversation | null;
  tasks: Task[];
  approvals: Approval[];
  artifacts: Artifact[];
  allMessages: StoredMessage[];
  storedMessages: StoredMessage[];
  imageAttachments: TaskImageAttachmentSummary[];
  schedules: Schedule[];
  skills: Skill[];
  showReasoning: boolean;
  modelEndpoints?: ModelEndpoint[];
  onBack: () => void;
  onChanged: () => Promise<void>;
  onCreate: () => void;
  onCreateGroup: () => void;
  onManageCoworker: (coworker: Coworker) => void;
  onNewConversation: () => Promise<void>;
  onOpenApprovals: () => void;
  onSelectCoworker: (coworker: Coworker) => void;
  onSelectConversation: (conversationId: string) => void;
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
  const coworkerTasks = tasks.filter(
    (task) => task.coworkerId === coworker.id && task.threadId === conversationId,
  );
  const latestTask = coworkerTasks.reduce<Task | null>(
    (latest, task) => (!latest || task.createdAt > latest.createdAt ? task : latest),
    null,
  );
  const pending = approvals.filter((approval) => approval.status === "PENDING");
  const renderToolCall = useRenderToolCall();
  const { rosterStyle, resizeRoster, resetRoster } = useConversationRosterWidth();
  const [railHidden, setRailHidden] = useState(
    () => window.localStorage.getItem("conversation-rail-hidden") === "true",
  );
  const [draft, setDraft] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [readingImages, setReadingImages] = useState(false);
  const [draggingImages, setDraggingImages] = useState(false);
  const [supportsImageInput, setSupportsImageInput] = useState<boolean | null>(null);
  const [search, setSearch] = useState("");
  const [conversationSearch, setConversationSearch] = useState("");
  const [conversationSearchResults, setConversationSearchResults] = useState<
    Conversation[] | null
  >(null);
  const [conversationSearchLoading, setConversationSearchLoading] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [coworkerMenu, setCoworkerMenu] = useState<{
    coworker: Coworker;
    x: number;
    y: number;
  } | null>(null);
  const [conversationBusy, setConversationBusy] = useState(false);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [pendingArchive, setPendingArchive] = useState<Conversation | null>(null);
  const [approvalInFlight, setApprovalInFlight] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [externalLiveResponses, setExternalLiveResponses] = useState<
    Record<string, LiveResponse>
  >({});
  // The surface remounts when the conversation changes, so the chosen tab is
  // remembered: following a schedule's "Replies in" link must not silently
  // drop you back on Files.
  const [rightRailTab, setRightRailTabState] = useState<"files" | "approvals" | "schedules">(
    () => {
      const stored = window.localStorage.getItem("conversation-rail-tab");
      if (stored === "files" || stored === "approvals" || stored === "schedules") {
        return stored;
      }
      return pending.length > 0 ? "approvals" : "files";
    },
  );
  function setRightRailTab(tab: "files" | "approvals" | "schedules") {
    setRightRailTabState(tab);
    window.localStorage.setItem("conversation-rail-tab", tab);
  }
  const [scheduleEditorOpen, setScheduleEditorOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);
  const [scheduleBusy, setScheduleBusy] = useState<string | null>(null);
  const [scheduleNotice, setScheduleNotice] = useState<string | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const imageDragDepth = useRef(0);
  const liveMessageTimes = useRef(new Map<string, string>());
  const externalRunIds = useRef(new Set<string>());
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
  // Schedules arrive for the whole workspace; the rail only speaks for the
  // coworker whose conversation is open, with the soonest run first.
  const coworkerSchedules = schedules
    .filter((schedule) => schedule.coworkerId === coworker.id)
    .sort((left, right) => {
      if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
      return (left.nextRunAt ?? "9999").localeCompare(right.nextRunAt ?? "9999");
    });
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  // An approval belongs to the conversation whose task raised it, so the
  // decision can be made in the thread that asked for it instead of a rail.
  const conversationApprovals = approvals
    .filter((approval) => tasksById.get(approval.taskId)?.threadId === conversationId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const conversationTaskCounts = new Map<string, number>();
  for (const task of tasks) {
    if (task.coworkerId !== coworker.id) continue;
    conversationTaskCounts.set(task.threadId, (conversationTaskCounts.get(task.threadId) ?? 0) + 1);
  }
  const locallyFilteredConversations = filterConversations(
    [...conversations].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    tasks.filter((task) => task.coworkerId === coworker.id),
    allMessages,
    conversationSearch,
  );
  const sortedConversations = (
    conversationSearch.trim()
      ? (conversationSearchResults ?? locallyFilteredConversations)
      : locallyFilteredConversations
  ).filter((item) => !item.archivedAt);

  async function archiveConversation(target: Conversation) {
    try {
      await window.coworker.conversations.archive(target.id);
      if (target.id === conversationId) {
        onSelectConversation(`coworker:${coworker.id}`);
      }
      await onChanged();
    } catch (archiveError) {
      setConversationError(
        archiveError instanceof Error ? archiveError.message : String(archiveError),
      );
    }
  }

  useEffect(() => {
    liveMessageTimes.current.clear();
    externalRunIds.current.clear();
    setExternalLiveResponses({});
  }, [conversationId]);

  useEffect(() => {
    const ipcAgent = agent instanceof IpcCoworkerAgent ? agent : null;
    return window.coworker.events.subscribe((event) => {
      if (
        event.type !== "agent.event" ||
        event.coworkerId !== coworker.id ||
        event.conversationId !== conversationId ||
        ipcAgent?.ownsRun(event.runId)
      ) {
        return;
      }
      const type = event.event.type;
      if (type === EventType.RUN_STARTED || type === EventType.TEXT_MESSAGE_CONTENT) {
        externalRunIds.current.add(event.runId);
        setExternalLiveResponses((current) => updateLiveResponses(current, event));
        return;
      }
      if (type !== EventType.RUN_FINISHED && type !== EventType.RUN_ERROR) return;
      if (!externalRunIds.current.has(event.runId)) return;
      setExternalLiveResponses((current) => {
        if (!current[event.runId]) return current;
        if (
          type === EventType.RUN_ERROR &&
          (event.event as { code?: string }).code !== "RUN_ABORTED"
        ) {
          return updateLiveResponses(current, event);
        }
        return current;
      });
      void Promise.all([
        onChanged(),
        window.coworker.messages.listConversation(conversationId),
      ])
        .then(([, history]) => {
          agent.setMessages(
            history
              .filter((message) => message.role === "user" || message.role === "assistant")
              .map((message) => ({
                id: message.id,
                role: message.role as "user" | "assistant",
                content: message.content,
              })),
          );
        })
        .finally(() => {
          externalRunIds.current.delete(event.runId);
          setExternalLiveResponses((current) => {
            const next = { ...current };
            delete next[event.runId];
            return next;
          });
        });
    });
  }, [agent, conversationId, coworker.id, onChanged]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [agent.messages.length, agent.isRunning, externalLiveResponses]);

  useEffect(() => {
    if (!historyOpen) return;
    const close = (event: PointerEvent) => {
      if (!historyRef.current?.contains(event.target as Node)) setHistoryOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHistoryOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [historyOpen]);

  useEffect(() => {
    if (!pendingArchive) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPendingArchive(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pendingArchive]);

  useEffect(() => {
    const query = conversationSearch.trim();
    if (!query) {
      setConversationSearchResults(null);
      setConversationSearchLoading(false);
      return;
    }
    let cancelled = false;
    setConversationSearchResults(null);
    setConversationSearchLoading(true);
    const timer = setTimeout(() => {
      void window.coworker.conversations
        .search(coworker.id, query)
        .then((results) => {
          if (!cancelled) setConversationSearchResults(results);
        })
        .catch((error) => {
          if (!cancelled) {
            setConversationError(error instanceof Error ? error.message : String(error));
          }
        })
        .finally(() => {
          if (!cancelled) setConversationSearchLoading(false);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [conversationSearch, coworker.id]);

  useEffect(() => {
    if (!coworkerMenu) return;
    const close = () => setCoworkerMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [coworkerMenu]);

  async function startNewConversation() {
    if (agent.isRunning || conversationBusy) return;
    setConversationBusy(true);
    setConversationError(null);
    setHistoryOpen(false);
    try {
      await onNewConversation();
    } catch (error) {
      setConversationError(error instanceof Error ? error.message : String(error));
    } finally {
      setConversationBusy(false);
    }
  }

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
    name: "skills.read",
    parameters: skillReadSchema,
    render: ({ status, parameters }) => (
      <div className="tool-card conversation-tool-card skill-used-card">
        <span className="tool-card-icon">
          <Icon name="check" />
        </span>
        <span>
          <small>{status === "complete" ? "Skill used" : "Loading skill"}</small>
          <strong>{parameters.name}</strong>
          {parameters.path ? <span>{parameters.path}</span> : null}
        </span>
      </div>
    ),
  });
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
              <small>Invoice</small>
              <strong>{parameters.client || "New invoice"}</strong>
            </span>
            <span className="invoice-state">
              {status === "complete"
                ? `${(parameters.format || "file").toUpperCase()} ready`
                : "Preparing"}
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
                .map((format) => officeFormatLabel[format])
                .join(" + ") || "Document"}
            </strong>
            <span>{parameters.sourcePath || parameters.name || "Workspace document"}</span>
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
          ? parameters.cronExpression
            ? describeCronExpression(parameters.cronExpression)
            : "Recurring schedule"
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

  async function attachImages(files: FileList | File[] | null) {
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

  async function decideApproval(approval: Approval, decision: "approve" | "reject") {
    setApprovalInFlight(approval.id);
    setApprovalError(null);
    try {
      await window.coworker.approvals.decide({ approvalId: approval.id, decision });
      await onChanged();
    } catch (error) {
      setApprovalError(error instanceof Error ? error.message : String(error));
    } finally {
      setApprovalInFlight(null);
    }
  }

  async function toggleSchedule(schedule: Schedule) {
    setScheduleBusy(schedule.id);
    setScheduleError(null);
    try {
      await window.coworker.schedules.update(schedule.id, { enabled: !schedule.enabled });
      await onChanged();
    } catch (error) {
      setScheduleError(error instanceof Error ? error.message : String(error));
    } finally {
      setScheduleBusy(null);
    }
  }

  async function runScheduleNow(schedule: Schedule) {
    setScheduleBusy(schedule.id);
    setScheduleError(null);
    setScheduleNotice(null);
    try {
      const task = await window.coworker.schedules.runNow(schedule.id);
      await onChanged();
      setScheduleNotice(`“${task.title}” is queued.`);
    } catch (error) {
      setScheduleError(error instanceof Error ? error.message : String(error));
    } finally {
      setScheduleBusy(null);
    }
  }

  let previousMessageDay: string | null = null;
  // Approvals are interleaved into the transcript by the time they were
  // raised, so a decision never floats below messages that came after it.
  let approvalCursor = 0;

  function takeApprovalsUntil(timestamp: string): ApprovalEntry[] {
    const due: ApprovalEntry[] = [];
    while (approvalCursor < conversationApprovals.length) {
      const approval = conversationApprovals[approvalCursor];
      if (!approval || approval.createdAt > timestamp) break;
      const dayKey = messageDayKey(approval.createdAt);
      const divider = dayKey === previousMessageDay ? null : approval.createdAt;
      previousMessageDay = dayKey;
      due.push({ approval, divider });
      approvalCursor += 1;
    }
    return due;
  }

  function renderApprovalEntries(entries: ApprovalEntry[]) {
    return entries.map(({ approval, divider }) => (
      <Fragment key={approval.id}>
        {divider ? (
          <div className="conversation-date-divider">
            <span>{messageDayLabel(divider)}</span>
          </div>
        ) : null}
        {approval.status === "PENDING" ? (
          <div className="workroom-approval">
            <header>
              <span className="workroom-approval-icon">
                <Icon name="shield" />
              </span>
              <span>
                <small>
                  {formatActionType(approval.actionType)} · {approval.riskLevel} risk
                </small>
                <strong>{approval.summary}</strong>
              </span>
            </header>
            <div className="workroom-approval-details">
              {approvalPreviewRows(approval).map(([label, value]) => (
                <span key={label}>
                  <small>{label}</small>
                  <strong>{value}</strong>
                </span>
              ))}
            </div>
            <div className="workroom-approval-actions">
              <button
                className="quick-approve-button"
                disabled={approvalInFlight === approval.id}
                onClick={() => void decideApproval(approval, "approve")}
              >
                <Icon name="check" />
                {approvalInFlight === approval.id ? "Approving…" : "Approve"}
              </button>
              <button
                className="workroom-approval-reject"
                disabled={approvalInFlight === approval.id}
                onClick={() => void decideApproval(approval, "reject")}
              >
                Reject
              </button>
              <button className="quick-review-button" onClick={onOpenApprovals}>
                Review
              </button>
            </div>
            <small className="workroom-message-meta">
              {coworker.name} is waiting · {formatMessageTime(approval.createdAt)}
            </small>
          </div>
        ) : (
          <div className="workroom-approval-resolved">
            <Icon name={approval.status === "REJECTED" ? "stop" : "check"} />
            <span>
              <strong>{approval.summary}</strong>
              <small>
                {approval.status.toLowerCase()}
                {approval.decidedAt ? ` · ${formatMessageTime(approval.decidedAt)}` : ""}
              </small>
            </span>
          </div>
        )}
      </Fragment>
    ));
  }

  const railToggle = (
    <button
      aria-label={railHidden ? "Show the side panel" : "Hide the side panel"}
      aria-pressed={!railHidden}
      className={
        railHidden
          ? "conversation-icon-button conversation-rail-toggle"
          : "conversation-icon-button conversation-rail-toggle active"
      }
      onClick={() =>
        setRailHidden((current) => {
          const next = !current;
          window.localStorage.setItem("conversation-rail-hidden", String(next));
          return next;
        })
      }
      title={
        railHidden
          ? "Show the files and approvals panel"
          : "Hide the files and approvals panel"
      }
      type="button"
    >
      <Icon name="panel" />
    </button>
  );

  return (
    <div
      className={
        railHidden
          ? "coworker-detail conversation-layout rail-hidden"
          : "coworker-detail conversation-layout"
      }
      style={rosterStyle}
    >
      <div className="conversation-window-drag" />

      <aside className="conversation-roster-panel">
        <ConversationRosterResizeHandle onReset={resetRoster} onResize={resizeRoster} />
        <header className="conversation-roster-head">
          <h1>Coworkers</h1>
          <span className="conversation-roster-actions">
            {/* Channel creation is hidden until group channels are ready. */}
            <button
              className="conversation-icon-button"
              onClick={onCreate}
              aria-label="Create coworker"
              title="Create coworker"
            >
              <Icon name="plus" />
            </button>
          </span>
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
          {conversations
            .filter((conversation) => conversation.kind === "group" && !conversation.archivedAt)
            .map((conversation) => (
              <button
                className="conversation-roster-item channel-roster-item"
                key={conversation.id}
                onClick={() => onSelectConversation(conversation.id)}
                type="button"
              >
                <span className="conversation-avatar group-channel-avatar">
                  <Icon name="spark" />
                </span>
                <span className="conversation-roster-copy">
                  <span>
                    <strong>{conversation.title}</strong>
                    <time>{formatRelativeTime(conversation.updatedAt)}</time>
                  </span>
                  <small>
                    {conversation.memberIds
                      .map((id) => coworkers.find((item) => item.id === id)?.name)
                      .filter(Boolean)
                      .join(", ")}
                  </small>
                </span>
              </button>
            ))}
          {visibleCoworkers.map((item) => {
            const latestTask = tasks
              .filter((task) => task.coworkerId === item.id)
              .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
            const waiting = pending.filter((approval) => approval.coworkerId === item.id).length;
            return (
              <CoworkerRosterItem
                coworker={item}
                key={item.id}
                latestTask={latestTask}
                modelEndpoints={modelEndpoints}
                onOpenContextMenu={({ x, y }) => {
                  setCoworkerMenu({
                    coworker: item,
                    x,
                    y,
                  });
                }}
                onSelect={() => onSelectCoworker(item)}
                selected={item.id === coworker.id}
                waiting={waiting}
              />
            );
          })}
          {visibleCoworkers.length === 0 ? (
            <p className="conversation-roster-empty">No coworkers match “{search}”.</p>
          ) : null}
        </nav>
        {coworkerMenu ? (
          <div
            className="coworker-context-menu"
            onPointerDown={(event) => event.stopPropagation()}
            role="menu"
            style={{ left: coworkerMenu.x, top: coworkerMenu.y }}
          >
            <button
              onClick={() => {
                onManageCoworker(coworkerMenu.coworker);
                setCoworkerMenu(null);
              }}
              role="menuitem"
              type="button"
            >
              <Icon name="settings" />
              Open {coworkerMenu.coworker.name} settings
            </button>
          </div>
        ) : null}
        <button className="conversation-workroom-link" onClick={onBack}>
          <Icon name="home" />
          <span>Back to workspace</span>
        </button>
      </aside>

      <section
        className="conversation-main"
        onDragEnter={(event) => {
          event.preventDefault();
          imageDragDepth.current += 1;
          if (supportsImageInput !== false && !agent.isRunning) setDraggingImages(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          imageDragDepth.current = Math.max(0, imageDragDepth.current - 1);
          if (imageDragDepth.current === 0) setDraggingImages(false);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          imageDragDepth.current = 0;
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDraggingImages(false);
          if (supportsImageInput === false || agent.isRunning) return;
          void attachImages(event.dataTransfer.files);
        }}
      >
        <header className="conversation-main-head">
          <div className="conversation-head-profile">
            <CoworkerAvatar className="conversation-avatar active" coworker={coworker} />
            <span className="conversation-identity">
              <span className="conversation-identity-title">
                <strong>{coworker.name}</strong>
                <StatusLabel status={coworker.runtimeStatus} />
              </span>
              <small className="conversation-current-title">
                {coworker.role} · {selectedConversation?.title ?? "New conversation"}
              </small>
              <span className="conversation-identity-tools">
                <QuickModelSwitcher
                  coworker={coworker}
                  disabled={agent.isRunning}
                  modelEndpoints={modelEndpoints}
                  onChanged={onChanged}
                />
              </span>
            </span>
            <span className="conversation-profile-tools">
              <button
                className="conversation-icon-button"
                onClick={() => onManageCoworker(coworker)}
                aria-label={`Configure ${coworker.name}`}
                title={`Configure ${coworker.name}`}
              >
                <Icon name="settings" />
              </button>
            </span>
          </div>
          <div className="conversation-head-controls">
            {selectedConversation && conversationId !== `coworker:${coworker.id}` ? (
              <button
                aria-label="Archive this conversation"
                className="conversation-icon-button"
                disabled={agent.isRunning || conversationBusy}
                onClick={() => setPendingArchive(selectedConversation)}
                title="Archive this conversation"
                type="button"
              >
                <Icon name="archive" />
              </button>
            ) : null}
            <div className="conversation-history-control" ref={historyRef}>
              <button
                aria-expanded={historyOpen}
                aria-haspopup="dialog"
                className="conversation-history-trigger"
                disabled={agent.isRunning}
                onClick={() => setHistoryOpen((open) => !open)}
                type="button"
              >
                <Icon name="clock" />
                <span>History</span>
              </button>
              {historyOpen ? (
                <div
                  className="menu-backdrop"
                  onPointerDown={() => setHistoryOpen(false)}
                  role="presentation"
                />
              ) : null}
              {historyOpen ? (
                <div
                  aria-label="Conversation history"
                  className="conversation-history-menu"
                  role="dialog"
                >
                  <header>
                    <span>
                      <strong>Past conversations</strong>
                      <small>Continue where you left off</small>
                    </span>
                    <button
                      aria-label="Start a new conversation"
                      onClick={() => void startNewConversation()}
                      title="Start a new conversation"
                      type="button"
                    >
                      <Icon name="plus" />
                    </button>
                  </header>
                  <label className="conversation-history-search">
                    <Icon name="search" />
                    <input
                      aria-label="Search conversations"
                      onChange={(event) => setConversationSearch(event.target.value)}
                      placeholder="Search titles and messages"
                      value={conversationSearch}
                    />
                  </label>
                  <div className="conversation-history-list">
                    {sortedConversations.map((conversation) => (
                      <div
                        className={
                          conversation.id === conversationId
                            ? "conversation-history-row selected"
                            : "conversation-history-row"
                        }
                        key={conversation.id}
                      >
                        <button
                          aria-current={conversation.id === conversationId ? "true" : undefined}
                          className="conversation-history-select"
                          onClick={() => {
                            onSelectConversation(conversation.id);
                            setHistoryOpen(false);
                            setConversationError(null);
                          }}
                          type="button"
                        >
                          <span>
                            <strong>{conversation.title}</strong>
                            <small>
                              {conversationTaskCounts.get(conversation.id) ?? 0} turns ·{" "}
                              {formatRelativeTime(conversation.updatedAt)}
                            </small>
                          </span>
                          {conversation.id === conversationId ? <Icon name="check" /> : null}
                        </button>
                        {conversation.id !== `coworker:${coworker.id}` ? (
                          <button
                            aria-label={`Archive “${conversation.title}”`}
                            className="conversation-history-archive"
                            onClick={() => {
                              setHistoryOpen(false);
                              setPendingArchive(conversation);
                            }}
                            title="Archive conversation"
                            type="button"
                          >
                            <Icon name="archive" />
                          </button>
                        ) : null}
                      </div>
                    ))}
                    {conversationSearchLoading ? (
                      <p className="conversation-history-empty">Searching all messages…</p>
                    ) : sortedConversations.length === 0 ? (
                      <p className="conversation-history-empty">
                        No conversations match “{conversationSearch}”.
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
            <button
              className="conversation-new-button"
              disabled={agent.isRunning || conversationBusy}
              onClick={() => void startNewConversation()}
              type="button"
            >
              <Icon name="plus" />
              <span>{conversationBusy ? "Starting…" : "New"}</span>
            </button>
            {railHidden ? railToggle : null}
          </div>
          {conversationError ? (
            <small className="conversation-head-error" role="alert">
              {conversationError}
            </small>
          ) : null}
        </header>

        <div className="conversation-thread">
          {agent.messages.length === 0 && Object.keys(externalLiveResponses).length === 0 ? (
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
              {agent.messages.map((message) => {
                if (message.role === "reasoning") {
                  if (!showReasoning) return null;
                  const reasoningText = textFromMessageContent(message.content);
                  if (!reasoningText) return null;
                  return (
                    <details className="workroom-reasoning" key={message.id}>
                      <summary>
                        <Icon name="spark" />
                        <span>Thinking</span>
                      </summary>
                      <div className="workroom-reasoning-text">{reasoningText}</div>
                    </details>
                  );
                }
                if (message.role !== "user" && message.role !== "assistant") return null;
                let timestamp = messageTimes.get(message.id) ?? liveMessageTimes.current.get(message.id);
                if (!timestamp) {
                  timestamp = new Date().toISOString();
                  liveMessageTimes.current.set(message.id, timestamp);
                }
                const dueApprovals = takeApprovalsUntil(timestamp);
                const dayKey = messageDayKey(timestamp);
                const showDayDivider = dayKey !== previousMessageDay;
                previousMessageDay = dayKey;
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
                  <Fragment key={message.id}>
                    {renderApprovalEntries(dueApprovals)}
                    {showDayDivider ? (
                      <div className="conversation-date-divider">
                        <span>{messageDayLabel(timestamp)}</span>
                      </div>
                    ) : null}
                    <div
                      className={`workroom-turn workroom-turn-${message.role}`}
                      data-message-role={message.role}
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
                        {content ? (
                          <span className="workroom-message-text">
                            {message.role === "assistant" ? (
                              <ChatMarkdown artifacts={artifacts}>{content}</ChatMarkdown>
                            ) : (
                              content
                            )}
                          </span>
                        ) : null}
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
                          {formatMessageTime(timestamp)}
                          {content ? <CopyTextButton text={content} /> : null}
                        </small>
                      ) : null}
                    </div>
                  </Fragment>
                );
              })}
              {/* Flushed above the live turns: a decision raised during this run
                  belongs before the answer it authorized, which is where timestamp
                  interleaving puts it once the run's messages persist. */}
              {renderApprovalEntries(takeApprovalsUntil("9999"))}
              {Object.entries(externalLiveResponses).map(([runId, response]) => (
                <div
                  className="workroom-turn workroom-turn-assistant"
                  data-message-role="assistant"
                  key={runId}
                >
                  <div className="workroom-bubble">
                    {response.content ? (
                      <span className="workroom-message-text">
                        <ChatMarkdown artifacts={artifacts}>{response.content}</ChatMarkdown>
                      </span>
                    ) : response.status === "failed" ? (
                      <span>{response.error}</span>
                    ) : (
                      <span className="workroom-running">
                        <span />
                        <span />
                        <span />
                      </span>
                    )}
                  </div>
                  <small className="workroom-message-meta">
                    {coworker.name} · live
                  </small>
                </div>
              ))}
              {approvalError ? (
                <div className="workroom-run-error" role="alert">
                  <Icon name="shield" />
                  <span>
                    <strong>Could not record that decision</strong>
                    <small>{approvalError}</small>
                  </span>
                </div>
              ) : null}
              {latestTask?.status === "FAILED" && latestTask.error ? (
                <div className="workroom-run-error" role="alert">
                  <Icon name="shield" />
                  <span>
                    <strong>Request could not complete</strong>
                    <small>{latestTask.error}</small>
                  </span>
                </div>
              ) : null}
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
              className={`workroom-composer${draggingImages ? " dragging-images" : ""}`}
              onSubmit={(event) => {
                event.preventDefault();
                void submitMessage(draft);
              }}
            >
              {draggingImages ? (
                <div className="composer-drop-prompt">
                  <Icon name="plus" /> Drop images to attach
                </div>
              ) : null}
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
                  title="Stop current task"
                  type="button"
                >
                  <Icon name="stop" />
                </button>
              ) : (
                <button
                  aria-label="Send message"
                  className="composer-send"
                  title="Send message"
                  disabled={
                    (!draft.trim() && pendingImages.length === 0) || !isReady || readingImages
                  }
                  type="submit"
                >
                  <Icon name="send" />
                </button>
              )}
              <div className="composer-footer">
                {imageError ? (
                  <small className="composer-error" role="alert">
                    {imageError}
                  </small>
                ) : supportsImageInput === false ? (
                  <small className="composer-capability-note">
                    This model doesn’t accept images.
                  </small>
                ) : (
                  <small>
                    {readingImages
                      ? "Preparing images…"
                      : `${coworker.name} can make mistakes. Review important actions.`}
                  </small>
                )}
                <QuickModelSwitcher
                  chip
                  coworker={coworker}
                  disabled={agent.isRunning}
                  modelEndpoints={modelEndpoints}
                  onChanged={onChanged}
                  placement="up"
                />
              </div>
            </form>
            <ComposerTools
              coworker={coworker}
              disabled={agent.isRunning}
              onChanged={onChanged}
              skills={skills}
            />
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
          <button
            aria-controls="conversation-schedules-panel"
            aria-selected={rightRailTab === "schedules"}
            className={rightRailTab === "schedules" ? "active" : ""}
            id="conversation-schedules-tab"
            onClick={() => setRightRailTab("schedules")}
            role="tab"
            type="button"
          >
            <Icon name="clock" />
            <span>Schedules</span>
            <b>{coworkerSchedules.length}</b>
          </button>
          {railToggle}
        </header>

        {rightRailTab === "schedules" ? (
          <section
            aria-labelledby="conversation-schedules-tab"
            className="conversation-schedule-rail"
            id="conversation-schedules-panel"
            role="tabpanel"
          >
            <header className="conversation-file-rail-head">
              <span>
                <strong>{coworker.name}’s schedules</strong>
                <small>Recurring work queued automatically</small>
              </span>
              <button
                className="conversation-schedule-new"
                onClick={() => {
                  setEditingSchedule(null);
                  setScheduleEditorOpen(true);
                }}
                type="button"
              >
                <Icon name="plus" />
                New
              </button>
            </header>

            {scheduleNotice ? (
              <div className="conversation-schedule-notice" role="status">
                {scheduleNotice}
              </div>
            ) : null}
            {scheduleError ? (
              <div className="quick-approval-error" role="alert">
                {scheduleError}
              </div>
            ) : null}

            <div className="conversation-schedule-list">
              {coworkerSchedules.length === 0 ? (
                <div className="conversation-file-empty">
                  <span>
                    <Icon name="clock" />
                  </span>
                  <strong>No schedules yet</strong>
                  <small>
                    Give {coworker.name} a rhythm — a daily digest or a Friday check.
                  </small>
                </div>
              ) : (
                coworkerSchedules.map((schedule) => (
                  <article
                    className={
                      schedule.enabled
                        ? "conversation-schedule-card"
                        : "conversation-schedule-card disabled"
                    }
                    key={schedule.id}
                  >
                    <div className="conversation-schedule-copy">
                      <strong title={schedule.name}>{schedule.name}</strong>
                      <small>{describeSchedule(schedule)}</small>
                      <p>
                        {schedule.enabled
                          ? `Next ${formatRelativeTime(schedule.nextRunAt)}`
                          : "Paused"}
                      </p>
                      <button
                        className="conversation-schedule-destination"
                        onClick={() =>
                          onSelectConversation(
                            schedule.conversationId ?? `coworker:${coworker.id}`,
                          )
                        }
                        title={scheduleDestination(schedule, conversations, coworker)}
                        type="button"
                      >
                        <Icon name="send" />
                        <span>{scheduleDestination(schedule, conversations, coworker)}</span>
                      </button>
                    </div>
                    <div className="conversation-schedule-actions">
                      <label className="toggle">
                        <input
                          checked={schedule.enabled}
                          disabled={scheduleBusy === schedule.id}
                          onChange={() => void toggleSchedule(schedule)}
                          type="checkbox"
                        />
                        <span />
                        <small>{schedule.enabled ? "On" : "Off"}</small>
                      </label>
                      <button
                        onClick={() => {
                          setEditingSchedule(schedule);
                          setScheduleEditorOpen(true);
                        }}
                        type="button"
                      >
                        Edit
                      </button>
                      <button
                        disabled={scheduleBusy === schedule.id}
                        onClick={() => void runScheduleNow(schedule)}
                        type="button"
                      >
                        Run now
                      </button>
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>
        ) : rightRailTab === "files" ? (
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

      {scheduleEditorOpen ? (
        <ScheduleEditorModal
          conversationId={conversationId}
          conversationTitle={conversationTitle(selectedConversation, coworker)}
          coworkers={[coworker]}
          defaultCoworkerId={coworker.id}
          lockCoworker
          onClose={() => {
            setScheduleEditorOpen(false);
            setEditingSchedule(null);
          }}
          onSaved={onChanged}
          schedule={editingSchedule}
        />
      ) : null}

      {pendingArchive ? (
        <div
          className="modal-backdrop"
          onMouseDown={() => setPendingArchive(null)}
          role="presentation"
        >
          <section
            aria-labelledby="archive-confirm-title"
            aria-modal="true"
            className="modal-card archive-confirm-modal"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <span className="eyebrow">Archive conversation</span>
            <h2 id="archive-confirm-title">Archive “{pendingArchive.title}”?</h2>
            <p>
              It will be hidden from your history. You can restore it — or delete it
              permanently — anytime from Settings → Archived.
            </p>
            <div className="modal-actions">
              <button
                className="secondary-button"
                onClick={() => setPendingArchive(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="primary-button"
                onClick={() => {
                  const target = pendingArchive;
                  setPendingArchive(null);
                  void archiveConversation(target);
                }}
                type="button"
              >
                Archive
              </button>
            </div>
          </section>
        </div>
      ) : null}
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

export function approvalPreviewRows(approval: Approval): Array<[string, string]> {
  const payload = approval.proposedPayload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [
      ["Action", formatActionType(approval.actionType)],
      ["Risk", approval.riskLevel],
    ];
  }

  const record = payload as Record<string, unknown>;
  const rows: Array<[string, string]> = [];
  if (approval.actionType.startsWith("schedules.")) {
    if (typeof record.name === "string") rows.push(["Name", record.name]);
    if (typeof record.cronExpression === "string") {
      rows.push(["Runs", describeCronExpression(record.cronExpression)]);
    } else if (typeof record.runAt === "string") {
      rows.push(["Runs", `Once on ${new Date(record.runAt).toLocaleString()}`]);
    }
    const template = record.taskTemplate;
    if (template && typeof template === "object" && !Array.isArray(template)) {
      const title = (template as Record<string, unknown>).title;
      if (typeof title === "string") rows.push(["Task", title]);
    }
    if (rows.length > 0) return rows.slice(0, 3);
  }
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
