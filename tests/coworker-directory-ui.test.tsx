// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TagInput } from "@renderer/components/TagInput";
import { insertMention, mentionQuery, mentionSuggestions, withReplyTag } from "@renderer/lib/coworker-filter";
import { CoworkersPage } from "@renderer/pages/CoworkersPage";
import { CoworkerRosterItem } from "@renderer/pages/CoworkerDetailPage";
import type { AppSettings, AppSnapshot, Coworker, Task } from "@shared/contracts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function coworker(id: string, name: string, tags: string[] = [], isPrimary = false): Coworker {
  return {
    id, name, role: `${name} specialist`, description: null, systemPrompt: "", modelProvider: "demo",
    modelName: "faux-1", status: "active", runtimeStatus: "IDLE", workspacePath: `/tmp/${id}`,
    enabledTools: [], enabledSkillIds: [], isPrimary, tags, policies: {}, sharedFolders: [],
    createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z",
  };
}

describe("tagging helpers", () => {
  const team = [coworker("bea", "Bea", ["legal"]), coworker("cy", "Cy Park", ["finance"])];

  it("only suggests while an @ is being typed", () => {
    expect(mentionQuery("hello")).toBeNull();
    expect(mentionQuery("email me at a@b.com")).toBeNull();
    expect(mentionQuery("ask @c")).toBe("c");
    expect(mentionSuggestions("hello", team)).toEqual([]);
  });

  it("matches by name, role or tag and skips coworkers already tagged", () => {
    expect(mentionSuggestions("ask @fin", team).map((c) => c.id)).toEqual(["cy"]);
    expect(mentionSuggestions("ask @", team).map((c) => c.id)).toEqual(["bea", "cy"]);
    expect(mentionSuggestions("ask @", team, ["bea"]).map((c) => c.id)).toEqual(["cy"]);
  });

  it("replaces the partial tag with the full name", () => {
    expect(insertMention("please @cy", "Cy Park")).toBe("please @Cy Park ");
  });

  it("starts a reply by tagging once, keeping what was already typed", () => {
    expect(withReplyTag("", "Sarah")).toBe("@Sarah ");
    expect(withReplyTag("  make it shorter", "Sarah")).toBe("@Sarah make it shorter");
    expect(withReplyTag("@sarah make it shorter", "Sarah")).toBe("@sarah make it shorter");
    expect(withReplyTag("ask @Sarahs team", "Sarah")).toBe("@Sarah ask @Sarahs team");
    expect(withReplyTag("", "Cy (Ops)")).toBe("@Cy (Ops) ");
  });
});

describe("coworker directory", () => {
  const settings = { defaultModelProvider: null, defaultModelName: null } as unknown as AppSettings;
  const team = [
    coworker("ava", "Ava", ["finance", "ops"]),
    coworker("bea", "Bea", ["legal"], true),
    coworker("cy", "Cy", ["finance"]),
  ];

  function renderPage() {
    render(<CoworkersPage coworkers={team} settings={settings} onOpen={vi.fn()} onChanged={vi.fn()} />);
  }

  it("lists the primary first with a badge", () => {
    window.localStorage.removeItem("coworker-directory-view");
    renderPage();
    const cards = document.querySelectorAll(".roster-card");
    expect(within(cards[0] as HTMLElement).getByText("Bea")).toBeTruthy();
    expect(within(cards[0] as HTMLElement).getByText("Primary")).toBeTruthy();
  });

  it("filters by search text and by clickable tag chips", () => {
    renderPage();
    const cardNames = () =>
      [...document.querySelectorAll(".roster-card .roster-name strong")].map((node) => node.textContent);
    expect(cardNames()).toEqual(["Bea", "Ava", "Cy"]);

    fireEvent.change(screen.getByLabelText("Search coworkers"), { target: { value: "legal" } });
    expect(cardNames()).toEqual(["Bea"]);
    expect(screen.getByText("1 of 3 coworkers")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search coworkers"), { target: { value: "" } });
    const filters = screen.getByRole("group", { name: "Filter by tag" });
    fireEvent.click(within(filters).getByRole("button", { name: "#finance" }));
    expect(cardNames()).toEqual(["Ava", "Cy"]);
    expect((screen.getByLabelText("Search coworkers") as HTMLInputElement).value).toBe("#finance");
    fireEvent.click(within(filters).getByRole("button", { name: "#ops" }));
    expect(cardNames()).toEqual(["Ava"]);
    fireEvent.click(within(filters).getByRole("button", { name: "#finance" }));
    fireEvent.click(within(filters).getByRole("button", { name: "#ops" }));
    expect(cardNames()).toEqual(["Bea", "Ava", "Cy"]);

    fireEvent.change(screen.getByLabelText("Search coworkers"), { target: { value: "nobody" } });
    expect(screen.getByText("No coworkers match “nobody”")).toBeTruthy();
  });
});

describe("tag input", () => {
  function Harness({ initial = [] as string[] }) {
    const [tags, setTags] = useState(initial);
    return (
      <>
        <TagInput tags={tags} onChange={setTags} />
        <output data-testid="tags">{tags.join(",")}</output>
      </>
    );
  }

  it("adds normalized, unique tags on Enter or comma and removes them", () => {
    render(<Harness />);
    const input = screen.getByLabelText("Add tag");
    fireEvent.change(input, { target: { value: " #Finance " } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "finance" } });
    fireEvent.keyDown(input, { key: "," });
    fireEvent.change(input, { target: { value: "ops" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("tags").textContent).toBe("finance,ops");

    fireEvent.click(screen.getByRole("button", { name: "Remove tag finance" }));
    expect(screen.getByTestId("tags").textContent).toBe("ops");
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(screen.getByTestId("tags").textContent).toBe("");
  });

  it("stops accepting tags at the limit", () => {
    render(<Harness initial={Array.from({ length: 10 }, (_, i) => `t${i}`)} />);
    expect((screen.getByLabelText("Add tag") as HTMLInputElement).disabled).toBe(true);
  });
});

describe("sidebar working indicator", () => {
  const task = (status: Task["status"]): Task => ({
    id: "t1", coworkerId: "bea", scheduleId: null, runId: "r1", threadId: "c1", sourceMessageId: null,
    discussionId: null, discussionTurn: null, title: "Draft the memo", input: "Draft the memo", status,
    source: "manual", priority: 0, result: null, error: null, createdAt: "2026-08-24T00:00:00.000Z",
    startedAt: null, completedAt: null,
  });

  function renderItem(runtimeStatus: Coworker["runtimeStatus"], status: Task["status"]) {
    render(
      <CoworkerRosterItem
        coworker={{ ...coworker("bea", "Bea"), runtimeStatus }}
        latestTask={task(status)}
        waiting={0}
        selected={false}
        onSelect={vi.fn()}
        onOpenContextMenu={vi.fn()}
      />,
    );
  }

  it("shows a working dot and a plain working label", () => {
    renderItem("WORKING", "RUNNING");
    expect(screen.getByRole("status", { name: "Bea is working" })).toBeTruthy();
    expect(screen.getByText("Working")).toBeTruthy();
    expect(screen.queryByText(/Draft the memo/)).toBeNull();
  });

  it("flags a coworker waiting for approval", () => {
    renderItem("WAITING_FOR_APPROVAL", "WAITING_FOR_APPROVAL");
    expect(screen.getByRole("status", { name: "Bea is waiting for approval" })).toBeTruthy();
    expect(screen.getByText("Waiting for your approval")).toBeTruthy();
  });

  it("marks the primary coworker", () => {
    render(
      <CoworkerRosterItem
        coworker={{ ...coworker("ava", "Ava", [], true), runtimeStatus: "IDLE" }}
        waiting={0}
        selected={false}
        onSelect={vi.fn()}
        onOpenContextMenu={vi.fn()}
      />,
    );
    expect(screen.getByText("Primary")).toBeTruthy();
  });

  it("shows the latest task when idle", () => {
    renderItem("IDLE", "COMPLETED");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("Primary")).toBeNull();
    expect(screen.getByText("Draft the memo")).toBeTruthy();
  });

  it("shows the role in a chip next to the name", () => {
    renderItem("IDLE", "COMPLETED");
    const chip = screen.getByText("Bea specialist");
    expect(chip.className).toBe("roster-role-chip");
    expect(chip.getAttribute("title")).toBe("Bea specialist");
  });
});

describe("pinned coworkers", () => {
  it("splits pinned coworkers out in pin order and keeps the rest in place", async () => {
    const { splitPinnedCoworkers, togglePinnedId } = await import("@renderer/lib/pinned-coworkers");
    const team = [
      { id: "ava", isPrimary: false },
      { id: "bea", isPrimary: false },
      { id: "cy", isPrimary: false },
      { id: "dee", isPrimary: false },
    ];
    expect(splitPinnedCoworkers(team, ["cy", "ava", "gone"])).toEqual({
      pinned: [team[2], team[0]],
      others: [team[1], team[3]],
    });
    // The primary is always pinned and on top, whether or not it was pinned by hand.
    const withPrimary = team.map((c) => ({ ...c, isPrimary: c.id === "dee" }));
    expect(splitPinnedCoworkers(withPrimary, ["cy", "dee"]).pinned.map((c) => c.id)).toEqual(["dee", "cy"]);
    expect(splitPinnedCoworkers(withPrimary, []).pinned.map((c) => c.id)).toEqual(["dee"]);
    expect(togglePinnedId(["ava"], "bea")).toEqual(["ava", "bea"]);
    expect(togglePinnedId(["ava", "bea"], "ava")).toEqual(["bea"]);
  });

  it("persists pins and tolerates bad storage", async () => {
    const { readPinnedCoworkerIds } = await import("@renderer/lib/pinned-coworkers");
    window.localStorage.setItem("pinned-coworkers", "not json");
    expect(readPinnedCoworkerIds()).toEqual([]);
    window.localStorage.setItem("pinned-coworkers", JSON.stringify(["ava", 3]));
    expect(readPinnedCoworkerIds()).toEqual(["ava"]);
    window.localStorage.removeItem("pinned-coworkers");
  });

  it("defaults to the coworker opened last, otherwise the top of the roster", async () => {
    const { defaultCoworkerId, rememberOpenedCoworker } = await import("@renderer/lib/pinned-coworkers");
    window.localStorage.removeItem("last-opened-coworker");
    window.localStorage.removeItem("pinned-coworkers");
    const team = [
      { id: "ava", isPrimary: false },
      { id: "bea", isPrimary: false },
      { id: "cy", isPrimary: false },
    ];
    expect(defaultCoworkerId([])).toBeNull();
    expect(defaultCoworkerId(team)).toBe("ava");
    window.localStorage.setItem("pinned-coworkers", JSON.stringify(["cy"]));
    expect(defaultCoworkerId(team)).toBe("cy");
    expect(defaultCoworkerId(team.map((c) => ({ ...c, isPrimary: c.id === "bea" })))).toBe("bea");
    rememberOpenedCoworker("ava");
    expect(defaultCoworkerId(team)).toBe("ava");
    // A coworker removed since it was last opened falls back to the roster.
    rememberOpenedCoworker("gone");
    expect(defaultCoworkerId(team)).toBe("cy");
    window.localStorage.removeItem("last-opened-coworker");
    window.localStorage.removeItem("pinned-coworkers");
  });
});

describe("primary change confirmation", () => {
  it("explains who stops being primary and confirms", async () => {
    const { PrimaryChangeDialog } = await import("@renderer/components/CoworkerActions");
    const onConfirm = vi.fn();
    render(
      <PrimaryChangeDialog
        busy={false}
        currentPrimary={coworker("ava", "Ava", [], true)}
        error={null}
        makePrimary
        onCancel={vi.fn()}
        onConfirm={onConfirm}
        target={coworker("bea", "Bea")}
      />,
    );
    expect(screen.getByRole("heading", { name: "Make Bea your primary coworker?" })).toBeTruthy();
    expect(screen.getByText(/Ava will no longer be primary/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Make Bea primary" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("confirms removing the primary and closes on Escape", async () => {
    const { PrimaryChangeDialog } = await import("@renderer/components/CoworkerActions");
    const onCancel = vi.fn();
    render(
      <PrimaryChangeDialog
        busy={false}
        currentPrimary={coworker("ava", "Ava", [], true)}
        error={null}
        makePrimary={false}
        onCancel={onCancel}
        onConfirm={vi.fn()}
        target={coworker("ava", "Ava", [], true)}
      />,
    );
    expect(screen.getByRole("heading", { name: "Remove Ava as primary?" })).toBeTruthy();
    expect(screen.getByText(/won’t have a primary coworker/)).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });
});

describe("pinned sidebar layout", () => {
  it("features the primary with role, working dot and context menu", async () => {
    const { PrimaryCoworkerHero } = await import("@renderer/pages/CoworkerDetailPage");
    const onSelect = vi.fn();
    const onOpenContextMenu = vi.fn();
    render(
      <PrimaryCoworkerHero
        coworker={{ ...coworker("ava", "Ava", [], true), role: "Chief of Staff", runtimeStatus: "WORKING" }}
        onOpenContextMenu={onOpenContextMenu}
        onSelect={onSelect}
        selected={false}
        waiting={2}
      />,
    );
    const hero = screen.getByRole("button", { name: "Ava, primary coworker" });
    expect(within(hero).getByText("Chief of Staff")).toBeTruthy();
    expect(within(hero).getByRole("status", { name: "Ava is working" })).toBeTruthy();
    expect(within(hero).getByText("2")).toBeTruthy();
    fireEvent.click(hero);
    fireEvent.contextMenu(hero, { clientX: 10, clientY: 20 });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onOpenContextMenu).toHaveBeenCalledWith({ x: 10, y: 20 });
  });

  it("shows pinned coworkers as avatar chips with names", async () => {
    const { PinnedCoworkerChip } = await import("@renderer/pages/CoworkerDetailPage");
    const onSelect = vi.fn();
    render(
      <div role="list">
        <PinnedCoworkerChip
          coworker={coworker("bea", "Bea")}
          onOpenContextMenu={vi.fn()}
          onSelect={onSelect}
          selected
          waiting={0}
        />
      </div>,
    );
    const chip = screen.getByRole("listitem");
    expect(chip.getAttribute("aria-current")).toBe("page");
    expect(within(chip).getByText("Bea")).toBeTruthy();
    expect(within(chip).queryByRole("status")).toBeNull();
    fireEvent.click(chip);
    expect(onSelect).toHaveBeenCalled();
  });
});

describe("coworker actions on the Coworkers page", () => {
  it("makes a coworker primary from the ⋯ menu after confirmation", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "coworker", {
      configurable: true,
      value: { coworkers: { update } },
    });
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const settings = { defaultModelProvider: null, defaultModelName: null } as unknown as AppSettings;
    render(
      <CoworkersPage
        coworkers={[coworker("ava", "Ava", [], true), coworker("bea", "Bea")]}
        settings={settings}
        onOpen={vi.fn()}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "More actions for Bea" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Make primary" }));
    expect(screen.getByText(/Ava will no longer be primary/)).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Make Bea primary" }));
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith("bea", { isPrimary: true }));
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("offers Remove as primary and a disabled pin for the primary", () => {
    const settings = { defaultModelProvider: null, defaultModelName: null } as unknown as AppSettings;
    render(
      <CoworkersPage
        coworkers={[coworker("ava", "Ava", [], true)]}
        settings={settings}
        onOpen={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    fireEvent.contextMenu(document.querySelector(".roster-card")!, { clientX: 5, clientY: 5 });
    expect(screen.getByRole("menuitem", { name: "Remove as primary" })).toBeTruthy();
    expect((screen.getByRole("menuitem", { name: "Pinned as primary" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Coworkers navigation", () => {
  const settings: AppSettings = {
    demoMode: false, launchAtLogin: false, runInBackground: true, theme: "forest", colorMode: "light",
    showReasoning: true, globalOperatingInstructions: "", defaultModelProvider: null, defaultModelName: null,
  };

  const finishedTask = (coworkerId: string): Task => ({
    id: `task-${coworkerId}`, coworkerId, scheduleId: null, runId: `run-${coworkerId}`,
    threadId: `coworker:${coworkerId}`, sourceMessageId: null, discussionId: null, discussionTurn: null,
    title: "Draft the memo", input: "Draft the memo", status: "COMPLETED", source: "manual", priority: 0,
    result: "Done.", error: null, createdAt: "2026-08-24T00:00:00.000Z", startedAt: "2026-08-24T00:00:00.000Z",
    completedAt: "2026-08-24T00:05:00.000Z",
  });

  function mockWorkroom(coworkers: Coworker[], tasks: Task[] = []) {
    // History that never arrives keeps the chat on its loading state.
    const listConversation = vi.fn((_conversationId: string) => new Promise<never>(() => undefined));
    const snapshot: AppSnapshot = {
      coworkers, conversations: [], discussions: [], tasks, messages: [],
      imageAttachments: [], approvals: [], schedules: [], artifacts: [], activity: [],
      integrations: [], modelEndpoints: [], skills: [], settings,
      dataPath: "/tmp/coworker-data", version: "0.6.1",
    };
    Object.defineProperty(window, "coworker", {
      configurable: true,
      value: {
        platform: "darwin",
        app: { bootstrap: async () => snapshot, getUpdateState: async () => ({ checking: false, availableVersion: null, notice: null }) },
        events: { subscribe: () => () => undefined },
        messages: { listConversation },
      },
    });
    return { listConversation };
  }

  async function renderApp() {
    const { default: App } = await import("@renderer/App");
    const { AppDataProvider } = await import("@renderer/state/AppDataProvider");
    render(<AppDataProvider><App /></AppDataProvider>);
    await screen.findByRole("textbox", { name: "Describe the task" });
  }

  const mainNavigation = () => screen.queryByRole("navigation", { name: "Main navigation" });

  it("opens a chat from the sidebar: the primary at first, then whoever was opened last", async () => {
    window.localStorage.removeItem("last-opened-coworker");
    const { listConversation } = mockWorkroom(
      [coworker("ava", "Ava"), coworker("bea", "Bea", [], true)],
      [finishedTask("ava")],
    );

    await renderApp();
    fireEvent.click(within(mainNavigation()!).getByRole("button", { name: "Coworkers" }));
    await vi.waitFor(() => expect(listConversation).toHaveBeenCalledWith("coworker:bea"));
    expect(mainNavigation()).toBeNull();
    cleanup();

    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /Open chat/ }));
    await vi.waitFor(() => expect(listConversation).toHaveBeenLastCalledWith("coworker:ava"));
    cleanup();
    listConversation.mockClear();

    await renderApp();
    fireEvent.click(within(mainNavigation()!).getByRole("button", { name: "Coworkers" }));
    await vi.waitFor(() => expect(listConversation).toHaveBeenCalledWith("coworker:ava"));
    expect(listConversation).not.toHaveBeenCalledWith("coworker:bea");
    window.localStorage.removeItem("last-opened-coworker");
  });

  it("opens the team chat from Home", async () => {
    window.localStorage.removeItem("last-opened-coworker");
    const { listConversation } = mockWorkroom([coworker("ava", "Ava")]);
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /Chat with team/ }));
    await vi.waitFor(() => expect(listConversation).toHaveBeenCalledWith("coworker:ava"));
    expect(mainNavigation()).toBeNull();
  });

  it("opens global settings from a coworker's chat", async () => {
    const snapshot: AppSnapshot = {
      coworkers: [coworker("ava", "Ava")], conversations: [], discussions: [], tasks: [], messages: [],
      imageAttachments: [], approvals: [], schedules: [], artifacts: [], activity: [],
      integrations: [], modelEndpoints: [], skills: [], settings,
      dataPath: "/tmp/coworker-data", version: "0.6.1",
    };
    // Every call the chat makes resolves empty unless listed here.
    const overrides: Record<string, unknown> = {
      platform: "darwin",
      "app.bootstrap": async () => snapshot,
      "app.getUpdateState": async () => ({ checking: false, availableVersion: null, notice: null }),
      "events.subscribe": () => () => undefined,
      "integrations.credentialStatus": async () => ({ configured: false }),
      "diagnostics.listProviderErrors": async () => [],
    };
    const api = (path: string): unknown =>
      new Proxy(function () {}, {
        get: (_target, prop) => {
          if (typeof prop === "symbol" || prop === "then") return undefined;
          const key = path ? `${path}.${prop}` : prop;
          return key in overrides ? overrides[key] : api(key);
        },
        apply: () => Promise.resolve([]),
      });
    Object.defineProperty(window, "coworker", { configurable: true, value: api("") });

    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /Chat with team/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
    expect(mainNavigation()).toBeTruthy();
  });

  it("opens the directory from Home when the team is empty", async () => {
    const { listConversation } = mockWorkroom([]);
    const { default: App } = await import("@renderer/App");
    const { AppDataProvider } = await import("@renderer/state/AppDataProvider");
    render(<AppDataProvider><App /></AppDataProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Create coworker" }));
    expect(screen.getByRole("searchbox", { name: "Search coworkers" })).toBeTruthy();
    expect(mainNavigation()).toBeTruthy();
    expect(listConversation).not.toHaveBeenCalled();
  });
});
