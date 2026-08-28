import { useEffect, useState } from "react";
import type { ActivityItem } from "@shared/contracts";
import { AppShell } from "./components/AppShell";
import { Icon } from "./components/Icon";
import type { PageId } from "./navigation";
import { ActivityPage } from "./pages/ActivityPage";
import { ApprovalsPage } from "./pages/ApprovalsPage";
import { CoworkerDetailPage } from "./pages/CoworkerDetailPage";
import { CoworkersPage } from "./pages/CoworkersPage";
import { FilesPage } from "./pages/FilesPage";
import { HomePage } from "./pages/HomePage";
import { SchedulesPage } from "./pages/SchedulesPage";
import { SettingsPage, type SettingsTab } from "./pages/SettingsPage";
import { useAppData } from "./state/AppDataProvider";

export default function App() {
  const { snapshot, loading, error, refresh, lastEvent } = useAppData();
  const [page, setPage] = useState<PageId>("home");
  const [selectedCoworkerId, setSelectedCoworkerId] = useState<string | null>(null);
  const [focusConversationId, setFocusConversationId] = useState<string | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const theme = snapshot?.settings.theme ?? "graphite";

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (lastEvent?.type === "navigation.requested") {
      setPage(lastEvent.page);
      setSelectedCoworkerId(null);
    }
  }, [lastEvent]);

  if (loading && !snapshot) {
    return (
      <div className="launch-screen">
        <span className="launch-mark">
          <span />
          <span />
        </span>
        <strong>Opening the workroom</strong>
        <small>Recovering local tasks and schedules…</small>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="fatal-screen">
        <Icon name="shield" />
        <h1>The local workroom could not open</h1>
        <p>{error ?? "The application did not return its local state."}</p>
        <button className="primary-button" onClick={() => void refresh()}>
          Try again
        </button>
      </div>
    );
  }

  const selectedCoworker = snapshot.coworkers.find(
    (coworker) => coworker.id === selectedCoworkerId,
  );
  const pendingApprovals = snapshot.approvals.filter(
    (approval) => approval.status === "PENDING",
  ).length;

  function navigate(nextPage: PageId) {
    setPage(nextPage);
    setSelectedCoworkerId(null);
    setFocusConversationId(null);
    setSettingsTab("general");
  }

  function openModelSettings() {
    setSettingsTab("models");
    setPage("settings");
    setSelectedCoworkerId(null);
  }

  function openCoworker(coworkerId: string, conversationId: string | null = null) {
    setPage("coworkers");
    setSelectedCoworkerId(coworkerId);
    setFocusConversationId(conversationId);
  }

  /** Jumps from an activity entry to the conversation or coworker behind it. */
  function openActivityTarget(item: ActivityItem) {
    if (!snapshot) return;
    const task = item.taskId
      ? snapshot.tasks.find((candidate) => candidate.id === item.taskId)
      : undefined;
    const coworkerId = task?.coworkerId ?? item.coworkerId;
    if (!coworkerId) return;
    openCoworker(coworkerId, task?.threadId ?? null);
  }

  return (
    <AppShell
      activePage={page}
      conversationMode={page === "coworkers" && Boolean(selectedCoworker)}
      onNavigate={navigate}
      pendingApprovals={pendingApprovals}
      version={snapshot.version}
    >
      {error ? (
        <div className="global-error">
          <span>{error}</span>
          <button onClick={() => void refresh()}>Retry</button>
        </div>
      ) : null}

      {page === "home" ? (
        <HomePage
          snapshot={snapshot}
          onOpenCoworker={(coworker) => openCoworker(coworker.id)}
          onOpenApprovals={() => navigate("approvals")}
          onManageCoworkers={() => navigate("coworkers")}
          onOpenActivity={() => navigate("activity")}
          onOpenActivityItem={openActivityTarget}
          onChanged={refresh}
        />
      ) : null}

      {page === "coworkers" && selectedCoworker ? (
        <CoworkerDetailPage
          coworker={selectedCoworker}
          coworkers={snapshot.coworkers}
          conversations={snapshot.conversations.filter(
            (conversation) => conversation.memberIds.includes(selectedCoworker.id),
          )}
          discussions={snapshot.discussions}
          tasks={snapshot.tasks}
          approvals={snapshot.approvals}
          artifacts={snapshot.artifacts.filter(
            (artifact) => artifact.coworkerId === selectedCoworker.id,
          )}
          messages={snapshot.messages.filter(
            (message) =>
              snapshot.conversations.some(
                (conversation) =>
                  conversation.id === message.conversationId &&
                  conversation.memberIds.includes(selectedCoworker.id),
              ),
          )}
          imageAttachments={snapshot.imageAttachments.filter(
            (attachment) => attachment.coworkerId === selectedCoworker.id,
          )}
          key={selectedCoworker.id}
          skills={snapshot.skills}
          settings={snapshot.settings}
          modelEndpoints={snapshot.modelEndpoints}
          initialConversationId={focusConversationId}
          onBack={() => navigate("home")}
          onChanged={refresh}
          onOpenApprovals={() => navigate("approvals")}
          onOpenModelSettings={openModelSettings}
          onRemoved={() => setSelectedCoworkerId(null)}
          onSelectCoworker={(coworker) => openCoworker(coworker.id)}
        />
      ) : null}

      {page === "coworkers" && !selectedCoworker ? (
        <CoworkersPage
          coworkers={snapshot.coworkers}
          settings={snapshot.settings}
          modelEndpoints={snapshot.modelEndpoints}
          integrations={snapshot.integrations}
          onOpen={(coworker) => openCoworker(coworker.id)}
          onChanged={refresh}
          onOpenModelSettings={openModelSettings}
        />
      ) : null}

      {page === "files" ? (
        <FilesPage
          artifacts={snapshot.artifacts}
          coworkers={snapshot.coworkers}
          tasks={snapshot.tasks}
          onOpenCoworker={(coworker) => openCoworker(coworker.id)}
        />
      ) : null}

      {page === "approvals" ? (
        <ApprovalsPage
          approvals={snapshot.approvals}
          coworkers={snapshot.coworkers}
          onChanged={refresh}
        />
      ) : null}
      {page === "schedules" ? (
        <SchedulesPage
          schedules={snapshot.schedules}
          coworkers={snapshot.coworkers}
          onChanged={refresh}
        />
      ) : null}
      {page === "activity" ? (
        <ActivityPage
          activity={snapshot.activity}
          coworkers={snapshot.coworkers}
          tasks={snapshot.tasks}
          onOpenItem={openActivityTarget}
        />
      ) : null}
      {page === "settings" ? (
        <SettingsPage
          settings={snapshot.settings}
          integrations={snapshot.integrations}
          modelEndpoints={snapshot.modelEndpoints}
          skills={snapshot.skills}
          coworkers={snapshot.coworkers}
          conversations={snapshot.conversations}
          dataPath={snapshot.dataPath}
          version={snapshot.version}
          initialTab={settingsTab}
          onChanged={refresh}
        />
      ) : null}
    </AppShell>
  );
}
