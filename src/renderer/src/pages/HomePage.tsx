import type { AppSnapshot, Coworker } from "@shared/contracts";
import { Icon } from "../components/Icon";
import {
  EmptyState,
  PageHeader,
  StatusLabel,
  formatRelativeTime,
  initials,
} from "../components/Primitives";

export function HomePage({
  snapshot,
  onOpenCoworker,
  onOpenApprovals,
}: {
  snapshot: AppSnapshot;
  onOpenCoworker: (coworker: Coworker) => void;
  onOpenApprovals: () => void;
}) {
  const pending = snapshot.approvals.filter((approval) => approval.status === "PENDING");
  const active = snapshot.coworkers.filter((coworker) =>
    ["WORKING", "WAITING_FOR_APPROVAL"].includes(coworker.runtimeStatus),
  ).length;

  return (
    <div className="page home-page">
      <PageHeader
        eyebrow="Team room"
        title={greeting()}
        description={`${active > 0 ? `${active} coworker${active === 1 ? " is" : "s are"} active` : "Your local team is ready"} · ${pending.length} decision${pending.length === 1 ? "" : "s"} waiting`}
      />

      <section className="team-bench" aria-labelledby="team-bench-title">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Live desk</span>
            <h2 id="team-bench-title">Your coworkers</h2>
          </div>
          <span className="bench-legend">
            <span className="pulse-dot" /> Updates from this computer
          </span>
        </div>
        <div className="bench-line" aria-hidden="true" />
        <div className="coworker-stations">
          {snapshot.coworkers.map((coworker, index) => {
            const task = snapshot.tasks.find(
              (candidate) =>
                candidate.coworkerId === coworker.id &&
                ["RUNNING", "WAITING_FOR_APPROVAL", "QUEUED"].includes(candidate.status),
            );
            return (
              <button
                className="coworker-station"
                key={coworker.id}
                onClick={() => onOpenCoworker(coworker)}
                style={{ "--station-index": index } as React.CSSProperties}
              >
                <span className={`station-node station-${coworker.runtimeStatus.toLowerCase()}`}>
                  <span>{initials(coworker.name)}</span>
                </span>
                <span className="station-copy">
                  <span className="station-title">
                    <strong>{coworker.name}</strong>
                    <StatusLabel status={coworker.runtimeStatus} />
                  </span>
                  <small>{coworker.role}</small>
                  <span className="station-task">
                    {task?.title ?? "Ready for a new task"}
                  </span>
                </span>
                <Icon name="arrow" className="station-arrow" />
              </button>
            );
          })}
        </div>
      </section>

      <div className="home-grid">
        <section className="panel decision-panel">
          <div className="section-heading compact">
            <div>
              <span className="eyebrow">Decision queue</span>
              <h2>Needs your call</h2>
            </div>
            {pending.length > 0 ? (
              <button className="text-button" onClick={onOpenApprovals}>
                View all <Icon name="arrow" />
              </button>
            ) : null}
          </div>
          {pending.length === 0 ? (
            <EmptyState
              icon="check"
              title="Nothing is blocked"
              body="Consequential actions will wait here before they run."
            />
          ) : (
            <div className="decision-list">
              {pending.slice(0, 3).map((approval) => {
                const coworker = snapshot.coworkers.find(
                  (candidate) => candidate.id === approval.coworkerId,
                );
                return (
                  <button key={approval.id} className="decision-row" onClick={onOpenApprovals}>
                    <span className="decision-avatar">{initials(coworker?.name ?? "?")}</span>
                    <span>
                      <small>{coworker?.name ?? "Coworker"} asks</small>
                      <strong>{approval.summary}</strong>
                    </span>
                    <span className={`risk-chip risk-${approval.riskLevel}`}>
                      {approval.riskLevel}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section className="panel activity-glance">
          <div className="section-heading compact">
            <div>
              <span className="eyebrow">Desk log</span>
              <h2>Recent movement</h2>
            </div>
          </div>
          <div className="mini-timeline">
            {snapshot.activity.slice(0, 6).map((item) => {
              const coworker = snapshot.coworkers.find(
                (candidate) => candidate.id === item.coworkerId,
              );
              return (
                <div className="mini-event" key={item.id}>
                  <span className="event-pin" />
                  <span>
                    <strong>{item.summary}</strong>
                    <small>
                      {coworker?.name ?? "Workroom"} · {formatRelativeTime(item.createdAt)}
                    </small>
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning. The room is open.";
  if (hour < 18) return "Good afternoon. Here’s the floor.";
  return "Good evening. Here’s where work stands.";
}
