import { useEffect, useState } from "react";
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
import { SettingsPage } from "./pages/SettingsPage";
import { useAppData } from "./state/AppDataProvider";

export default function App() {
  const { snapshot, loading, error, refresh, lastEvent } = useAppData();
  const [page, setPage] = useState<PageId>("home");
  const [selectedCoworkerId, setSelectedCoworkerId] = useState<string | null>(null);
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
  }

  return (
    <AppShell
      activePage={page}
      conversationMode={page === "coworkers" && Boolean(selectedCoworker)}
      onNavigate={navigate}
      pendingApprovals={pendingApprovals}
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
          onOpenCoworker={(coworker) => {
            setPage("coworkers");
            setSelectedCoworkerId(coworker.id);
          }}
          onOpenApprovals={() => navigate("approvals")}
        />
      ) : null}

      {page === "coworkers" && selectedCoworker ? (
        <CoworkerDetailPage
          coworker={selectedCoworker}
          coworkers={snapshot.coworkers}
          conversations={snapshot.conversations.filter(
            (conversation) => conversation.coworkerId === selectedCoworker.id,
          )}
          tasks={snapshot.tasks}
          approvals={snapshot.approvals}
          artifacts={snapshot.artifacts.filter(
            (artifact) => artifact.coworkerId === selectedCoworker.id,
          )}
          messages={snapshot.messages.filter(
            (message) => message.coworkerId === selectedCoworker.id,
          )}
          imageAttachments={snapshot.imageAttachments.filter(
            (attachment) => attachment.coworkerId === selectedCoworker.id,
          )}
          key={selectedCoworker.id}
          skills={snapshot.skills}
          settings={snapshot.settings}
          onBack={() => setSelectedCoworkerId(null)}
          onChanged={refresh}
          onOpenApprovals={() => navigate("approvals")}
          onRemoved={() => setSelectedCoworkerId(null)}
          onSelectCoworker={(coworker) => setSelectedCoworkerId(coworker.id)}
        />
      ) : null}

      {page === "coworkers" && !selectedCoworker ? (
        <CoworkersPage
          coworkers={snapshot.coworkers}
          settings={snapshot.settings}
          onOpen={(coworker) => setSelectedCoworkerId(coworker.id)}
          onChanged={refresh}
        />
      ) : null}

      {page === "files" ? (
        <FilesPage
          artifacts={snapshot.artifacts}
          coworkers={snapshot.coworkers}
          tasks={snapshot.tasks}
          onOpenCoworker={(coworker) => {
            setPage("coworkers");
            setSelectedCoworkerId(coworker.id);
          }}
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
        <ActivityPage activity={snapshot.activity} coworkers={snapshot.coworkers} />
      ) : null}
      {page === "settings" ? (
        <SettingsPage
          settings={snapshot.settings}
          integrations={snapshot.integrations}
          skills={snapshot.skills}
          coworkers={snapshot.coworkers}
          dataPath={snapshot.dataPath}
          version={snapshot.version}
          onChanged={refresh}
        />
      ) : null}
    </AppShell>
  );
}
