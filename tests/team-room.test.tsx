// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AppSettings,
  AppSnapshot,
  Approval,
  Artifact,
  Conversation,
  Coworker,
  Message,
  Task,
} from "@shared/contracts";
import {
  allActivity,
  approvalHighlights,
  buildTeamFeed,
  matchesFilters,
  teamStats,
  type TeamFeedFilters,
} from "@renderer/lib/team-feed";
import { HomePage } from "@renderer/pages/HomePage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const baseline = new Date(2026, 9, 3, 15, 0);
const at = (minutesBefore: number, from = baseline) => new Date(from.getTime() - minutesBefore * 60_000).toISOString();
const minutesAgo = (minutes: number) => at(minutes, new Date());

function coworker(id: string, name: string, extra: Partial<Coworker> = {}): Coworker {
  return {
    id, name, role: `${name} role`, description: null, systemPrompt: "", modelProvider: "demo", modelName: "faux-1",
    status: "active", runtimeStatus: "IDLE", workspacePath: `/tmp/${id}`, enabledTools: [], enabledSkillIds: [],
    isPrimary: false, tags: [], policies: {}, sharedFolders: [], createdAt: at(600), updatedAt: at(600), ...extra,
  };
}

function task(id: string, coworkerId: string, extra: Partial<Task> = {}): Task {
  return {
    id, coworkerId, scheduleId: null, runId: `run-${id}`, threadId: `thread-${coworkerId}`, sourceMessageId: null,
    discussionId: null, discussionTurn: null, title: `Task ${id}`, input: `Task ${id}`, status: "COMPLETED",
    source: "manual", priority: 0, result: null, error: null, createdAt: at(90), startedAt: at(90),
    completedAt: at(60), ...extra,
  };
}

function approval(id: string, taskId: string, extra: Partial<Approval> = {}): Approval {
  return {
    id, taskId, coworkerId: "ava", toolCallId: `call-${id}`, actionType: "email.send",
    summary: "Send 4 invoice reminders", proposedPayload: { subject: "Invoice reminder", to: "ap@example.test" },
    decidedPayload: null, riskLevel: "medium", status: "PENDING", createdAt: at(6), decidedAt: null, ...extra,
  };
}

function message(id: string, taskId: string, content: string, createdAt: string): Message {
  return {
    id, conversationId: "thread-ava", coworkerId: "ava", authorName: "Ava", taskId, role: "assistant", content,
    mentionedCoworkerIds: [], createdAt,
  };
}

function conversation(id: string, coworkerId: string): Conversation {
  return {
    id, coworkerId, kind: "direct", memberIds: [coworkerId], title: "Chat", archivedAt: null, createdAt: at(600),
    updatedAt: at(1),
  };
}

function artifact(id: string, coworkerId: string, name: string, createdAt: string): Artifact {
  return { id, taskId: null, coworkerId, name, mimeType: "application/octet-stream", filePath: `/tmp/${name}`, createdAt };
}

function snapshotWith(parts: Partial<AppSnapshot>): AppSnapshot {
  return {
    coworkers: [], conversations: [], discussions: [], tasks: [], messages: [], imageAttachments: [], messageImages: [], approvals: [],
    schedules: [], artifacts: [], activity: [], integrations: [], modelEndpoints: [], skills: [],
    settings: {} as AppSettings, dataPath: "/tmp/coworker", version: "0.6.1", ...parts,
  };
}

describe("team feed", () => {
  const ava = coworker("ava", "Ava", { runtimeStatus: "WORKING" });
  const sarah = coworker("sarah", "Sarah");

  it("puts live work and decisions under now, and finished work by day", () => {
    const snapshot = snapshotWith({
      coworkers: [ava, sarah],
      tasks: [
        task("running", "ava", { status: "RUNNING", startedAt: at(2), completedAt: null }),
        task("waiting", "ava", { status: "WAITING_FOR_APPROVAL", completedAt: null }),
        task("done", "sarah", { result: "All set.", completedAt: at(14) }),
        task("failed", "sarah", { status: "FAILED", error: "Model unavailable", completedAt: at(40) }),
        task("yesterday", "sarah", { completedAt: new Date(2026, 9, 2, 18, 0).toISOString() }),
        task("older", "sarah", { completedAt: new Date(2026, 8, 30, 18, 0).toISOString() }),
        task("cancelled", "sarah", { status: "CANCELLED" }),
        // Relays another coworker's reply, which already has its own card.
        task("relay", "ava", { replyFromCoworkerId: "sarah" }),
      ],
      approvals: [approval("a1", "waiting")],
      messages: [
        message("m0", "running", "Starting.", at(2)),
        message("m1", "running", "Pulled **230 transactions**.", at(1)),
      ],
    });

    const feed = buildTeamFeed(snapshot, baseline);

    expect(feed.map((item) => [item.id, item.state, item.section])).toEqual([
      ["running", "running", "now"],
      ["waiting", "needs-you", "now"],
      ["done", "done", "today"],
      ["failed", "failed", "today"],
      ["yesterday", "done", "yesterday"],
      ["older", "done", "earlier"],
    ]);
    expect(feed.map((item) => item.body)).toEqual([
      "Pulled **230 transactions**.",
      null,
      "All set.",
      "Model unavailable",
      null,
      null,
    ]);
    expect(feed[1]?.approval?.id).toBe("a1");
  });

  it("filters by time, status and coworker together", () => {
    const snapshot = snapshotWith({
      coworkers: [ava, sarah],
      tasks: [
        task("running", "ava", { status: "RUNNING", startedAt: at(2), completedAt: null }),
        task("waiting", "ava", { status: "WAITING_FOR_APPROVAL", completedAt: null }),
        task("today", "sarah", { completedAt: at(14) }),
        task("yesterday", "sarah", { status: "FAILED", completedAt: new Date(2026, 9, 2, 18, 0).toISOString() }),
        // The first of the last 7 days, and one day before it.
        task("six-days-ago", "sarah", { completedAt: new Date(2026, 8, 27, 0, 30).toISOString() }),
        task("seven-days-ago", "sarah", { completedAt: new Date(2026, 8, 26, 23, 30).toISOString() }),
      ],
      approvals: [approval("a1", "waiting")],
    });
    const feed = buildTeamFeed(snapshot, baseline);
    const ids = (filters: Partial<TeamFeedFilters>) =>
      feed.filter((item) => matchesFilters(item, { ...allActivity, ...filters }, baseline)).map((item) => item.id);

    expect(ids({})).toEqual(["running", "waiting", "today", "yesterday", "six-days-ago", "seven-days-ago"]);
    // Live work is happening now, so it belongs to today.
    expect(ids({ range: "today" })).toEqual(["running", "waiting", "today"]);
    expect(ids({ range: "yesterday" })).toEqual(["yesterday"]);
    expect(ids({ range: "week" })).toEqual(["running", "waiting", "today", "yesterday", "six-days-ago"]);
    expect(ids({ status: "in-progress" })).toEqual(["running"]);
    expect(ids({ status: "needs-you" })).toEqual(["waiting"]);
    expect(ids({ status: "failed" })).toEqual(["yesterday"]);
    expect(ids({ status: "done", range: "week", coworkerId: "sarah" })).toEqual(["today", "six-days-ago"]);
    expect(ids({ coworkerId: "ava", range: "yesterday" })).toEqual([]);
  });

  it("names who asked for delegated work", () => {
    const snapshot = snapshotWith({
      coworkers: [ava, sarah],
      conversations: [conversation("conv-ava", "ava")],
      tasks: [task("delegated", "sarah", { delegatedFromThreadId: "conv-ava", result: "Both renewals are on track." })],
    });

    const [item] = buildTeamFeed(snapshot, baseline);

    expect(item?.requester?.name).toBe("Ava");
    expect(item?.body).toBe("Both renewals are on track.");
  });

  it("counts working coworkers, open decisions and today's finished tasks", () => {
    const snapshot = snapshotWith({
      coworkers: [ava, sarah],
      tasks: [
        task("done", "sarah", { completedAt: at(14) }),
        task("yesterday", "sarah", { completedAt: new Date(2026, 9, 2, 18, 0).toISOString() }),
        task("running", "ava", { status: "RUNNING", completedAt: null }),
      ],
      approvals: [approval("a1", "running")],
    });

    expect(teamStats(snapshot, baseline)).toEqual({ working: 1, waiting: 1, doneToday: 1 });
  });

  it("lists open approvals first, then the latest decisions", () => {
    const approvals = [
      approval("approved", "t1", { status: "APPROVED", decidedAt: at(60) }),
      approval("open-older", "t2", { createdAt: at(30) }),
      approval("declined", "t3", { status: "REJECTED", decidedAt: at(180) }),
      approval("open-newer", "t4", { createdAt: at(6) }),
    ];

    expect(approvalHighlights(approvals, 3).map((item) => item.id)).toEqual([
      "open-newer",
      "open-older",
      "approved",
    ]);
  });
});

describe("team room", () => {
  function setup() {
    const decide = vi.fn(async () => ({}));
    const send = vi.fn(async () => ({}));
    const open = vi.fn(async () => undefined);
    Object.defineProperty(window, "coworker", {
      configurable: true,
      value: {
        platform: "darwin",
        approvals: { decide },
        conversations: { send, create: vi.fn() },
        tasks: { create: vi.fn() },
        artifacts: { open },
      },
    });
    const yesterdayNoon = new Date();
    yesterdayNoon.setDate(yesterdayNoon.getDate() - 1);
    yesterdayNoon.setHours(12, 0, 0, 0);
    const snapshot = snapshotWith({
      coworkers: [
        coworker("ava", "Ava", { role: "Accounting Coworker", runtimeStatus: "WORKING", isPrimary: true }),
        coworker("sarah", "Sarah", { role: "Sales Coworker" }),
      ],
      conversations: [conversation("thread-ava", "ava"), conversation("thread-sarah", "sarah")],
      tasks: [
        task("running", "ava", {
          title: "Reconcile September card statements", status: "RUNNING", startedAt: minutesAgo(2), completedAt: null,
        }),
        task("waiting", "ava", { title: "Invoice reminders", status: "WAITING_FOR_APPROVAL", completedAt: null }),
        task("pipeline", "sarah", {
          title: "Pull the Q3 pipeline", result: "Both renewals are in the contract stage.", completedAt: minutesAgo(14),
        }),
        task("recap", "ava", { title: "Send the weekly recap", completedAt: yesterdayNoon.toISOString() }),
      ],
      approvals: [approval("a1", "waiting", { createdAt: minutesAgo(6) })],
      messages: [message("m1", "running", "Pulled **230 transactions** from Mercury.", minutesAgo(1))],
      artifacts: [artifact("f1", "sarah", "pipeline-wk40.xlsx", minutesAgo(14))],
    });
    const props = {
      onOpenCoworker: vi.fn(),
      onChatWithTeam: vi.fn(),
      onOpenApprovals: vi.fn(),
      onManageCoworkers: vi.fn(),
      onOpenFiles: vi.fn(),
      onChanged: vi.fn(async () => undefined),
    };
    render(<HomePage snapshot={snapshot} {...props} />);
    return { decide, send, open, props };
  }

  it("shows each coworker's work as a feed, live work first", () => {
    setup();
    const greeting = screen.getByRole("heading", { level: 1 });
    expect(greeting.textContent).toMatch(/^Good (morning|afternoon|evening)!$/);
    // The art matches the greeting's time of day.
    const period = greeting.textContent!.match(/^Good (\w+)!$/)![1];
    expect(greeting.querySelector(`svg[data-period="${period}"]`)?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("Here’s what our team is busy with…")).toBeTruthy();
    const status = screen.getByLabelText("Team status").textContent;
    expect(status).toContain("1 running now");
    expect(status).toContain("1 decision waiting on you");
    const cards = within(screen.getByRole("region", { name: "Now" })).getAllByRole("article");
    expect(cards).toHaveLength(2);
    expect(cards[0]!.textContent).toContain("is working on Reconcile September card statements");
    expect(within(cards[0]!).getByText("230 transactions").tagName).toBe("STRONG");
    expect(within(cards[0]!).getByRole("status").textContent).toContain("Working…");
    expect(cards[1]!.textContent).toContain("wants to send 4 invoice reminders");
    expect(within(cards[1]!).getByText("Invoice reminder")).toBeTruthy();
  });

  it("decides an approval from its card or from the rail", async () => {
    const { decide, props } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Approve & send" }));
    await vi.waitFor(() => expect(decide).toHaveBeenCalledWith({ approvalId: "a1", decision: "approve" }));
    await vi.waitFor(() => expect(props.onChanged).toHaveBeenCalled());

    // Both copies of the decision stay disabled until the first one settles.
    const decline = within(screen.getByRole("region", { name: "Approvals" })).getByRole("button", { name: "Decline" });
    await vi.waitFor(() => expect((decline as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(decline);
    await vi.waitFor(() => expect(decide).toHaveBeenCalledWith({ approvalId: "a1", decision: "reject" }));
  });

  it("narrows the feed to today or yesterday", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 3, 15, 0));
    setup();
    const range = screen.getByRole("group", { name: "When" });
    expect(within(range).getByRole("button", { name: "Any time" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getAllByRole("article")).toHaveLength(4);
    expect(screen.getByRole("region", { name: "Yesterday" })).toBeTruthy();

    fireEvent.click(within(range).getByRole("button", { name: "Yesterday" }));
    const [recap] = screen.getAllByRole("article");
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(recap!.textContent).toContain("finished Send the weekly recap");

    // Live work counts as today.
    fireEvent.click(within(range).getByRole("button", { name: "Today" }));
    expect(screen.getAllByRole("article")).toHaveLength(3);
    expect(screen.queryByRole("region", { name: "Yesterday" })).toBeNull();
    expect(within(range).getByRole("button", { name: "Today" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("filters by status and coworker from their menus, and clears them", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 3, 15, 0));
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Status: Any status" }));
    const needsYou = within(screen.getByRole("listbox", { name: "Status" })).getByRole("option", { name: /Needs you/ });
    expect(needsYou.textContent).toContain("1");
    fireEvent.click(needsYou);
    expect(screen.queryByRole("listbox")).toBeNull();
    const [waiting] = screen.getAllByRole("article");
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(waiting!.textContent).toContain("wants to send 4 invoice reminders");

    // Filters combine, and nothing from Sarah needs you.
    fireEvent.click(screen.getByRole("button", { name: "Coworker: Everyone" }));
    fireEvent.click(screen.getByRole("option", { name: "Sarah" }));
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    expect(screen.getByText("Nothing matches these filters.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Status: Needs you" }));
    fireEvent.click(screen.getByRole("option", { name: "Any status" }));
    const [card] = screen.getAllByRole("article");
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(card!.textContent).toContain("finished Pull the Q3 pipeline");
    expect(card!.textContent).toContain("Both renewals are in the contract stage.");

    fireEvent.click(screen.getByRole("button", { name: "Coworker: Sarah" }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();

    const range = screen.getByRole("group", { name: "When" });
    fireEvent.click(within(range).getByRole("button", { name: "Yesterday" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getAllByRole("article")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Coworker: Everyone" })).toBeTruthy();
    expect(within(range).getByRole("button", { name: "Any time" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("replies to a coworker without leaving the team room", async () => {
    const { send, props } = setup();
    const card = screen.getAllByRole("article").find((item) => item.textContent?.includes("Pull the Q3 pipeline"))!;
    fireEvent.click(within(card).getByRole("button", { name: "Reply" }));
    fireEvent.change(within(card).getByRole("textbox", { name: "Reply to Sarah" }), {
      target: { value: "Thanks, share it with Ava" },
    });
    fireEvent.click(within(card).getByRole("button", { name: "Send" }));
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "thread-sarah",
          content: "Thanks, share it with Ava",
          mentionedCoworkerIds: [],
        }),
      ),
    );
    await vi.waitFor(() => expect(within(card).queryByRole("textbox", { name: "Reply to Sarah" })).toBeNull());

    fireEvent.click(within(card).getByRole("button", { name: /Open chat/ }));
    expect(props.onOpenCoworker).toHaveBeenCalledWith(expect.objectContaining({ id: "sarah" }), "thread-sarah");
  });

  it("renders the feed a page at a time as it scrolls", () => {
    type Entries = Array<{ isIntersecting: boolean }>;
    const observed: Array<(entries: Entries) => void> = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: (entries: Entries) => void) {
          observed.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    Object.defineProperty(window, "coworker", { configurable: true, value: { platform: "darwin" } });
    const snapshot = snapshotWith({
      coworkers: [coworker("sarah", "Sarah")],
      tasks: Array.from({ length: 30 }, (_, index) =>
        task(`t${index}`, "sarah", { completedAt: minutesAgo(index + 1) }),
      ),
    });
    render(
      <HomePage
        snapshot={snapshot}
        onOpenCoworker={vi.fn()}
        onChatWithTeam={vi.fn()}
        onOpenApprovals={vi.fn()}
        onManageCoworkers={vi.fn()}
        onOpenFiles={vi.fn()}
        onChanged={vi.fn(async () => undefined)}
      />,
    );
    expect(screen.getAllByRole("article")).toHaveLength(12);

    act(() => observed.at(-1)!([{ isIntersecting: true }]));
    expect(screen.getAllByRole("article")).toHaveLength(24);

    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getAllByRole("article")).toHaveLength(30);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();

    // A new filter starts again from the first page.
    fireEvent.click(screen.getByRole("button", { name: "Last 7 days" }));
    expect(screen.getAllByRole("article")).toHaveLength(12);
  });

  it("shows the current date and time at the top of the rail, turning over each minute", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 3, 17, 33, 20));
    setup();
    const clock = screen.getByRole("region", { name: "Current time" });
    expect(clock.textContent).toMatch(/^5:33\sPM/);
    expect(clock.textContent).toContain("2026");

    act(() => {
      vi.advanceTimersByTime(40_000);
    });
    expect(clock.textContent).toMatch(/^5:34\sPM/);
  });

  it("summarizes the team, approvals and recent files in the rail", () => {
    const { open, props } = setup();
    const team = screen.getByRole("region", { name: "Your team" });
    fireEvent.click(within(team).getByRole("button", { name: /Chat with team/ }));
    expect(props.onChatWithTeam).toHaveBeenCalled();

    const files = screen.getByRole("region", { name: "Recent files" });
    fireEvent.click(within(files).getByRole("button", { name: /pipeline-wk40\.xlsx/ }));
    expect(open).toHaveBeenCalledWith("f1");
    fireEvent.click(within(files).getByRole("button", { name: /All files/ }));
    expect(props.onOpenFiles).toHaveBeenCalled();
  });
});
