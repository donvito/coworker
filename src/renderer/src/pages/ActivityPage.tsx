import { useMemo, useState } from "react";
import type { ActivityItem, Coworker } from "@shared/contracts";
import { Icon } from "../components/Icon";
import { EmptyState, PageHeader, formatRelativeTime, initials } from "../components/Primitives";

export function ActivityPage({
  activity,
  coworkers,
}: {
  activity: ActivityItem[];
  coworkers: Coworker[];
}) {
  const [coworkerId, setCoworkerId] = useState("all");
  const filtered = useMemo(
    () =>
      coworkerId === "all"
        ? activity
        : activity.filter((item) => item.coworkerId === coworkerId),
    [activity, coworkerId],
  );
  const groups = groupByDay(filtered);

  return (
    <div className="page activity-page">
      <PageHeader
        eyebrow="Durable record"
        title="Activity"
        description="A chronological record of task, tool, approval, and runtime transitions."
        action={
          <select
            className="compact-select"
            value={coworkerId}
            onChange={(event) => setCoworkerId(event.target.value)}
            aria-label="Filter by coworker"
          >
            <option value="all">All coworkers</option>
            {coworkers.map((coworker) => (
              <option value={coworker.id} key={coworker.id}>
                {coworker.name}
              </option>
            ))}
          </select>
        }
      />

      {filtered.length === 0 ? (
        <EmptyState
          icon="activity"
          title="No movement recorded"
          body="Task and approval changes will build a local audit trail here."
        />
      ) : (
        <div className="activity-ledger">
          {groups.map(([day, items]) => (
            <section className="activity-day" key={day}>
              <header>
                <span>{day}</span>
                <small>{items.length} entries</small>
              </header>
              <div>
                {items.map((item) => {
                  const coworker = coworkers.find(
                    (candidate) => candidate.id === item.coworkerId,
                  );
                  return (
                    <article className="activity-entry" key={item.id}>
                      <span className={`activity-symbol event-${eventFamily(item.type)}`}>
                        {coworker ? initials(coworker.name) : <Icon name="activity" />}
                      </span>
                      <span className="activity-copy">
                        <strong>{item.summary}</strong>
                        <small>
                          {coworker?.name ?? "Workroom"} · {labelForType(item.type)}
                        </small>
                      </span>
                      <time dateTime={item.createdAt}>{formatRelativeTime(item.createdAt)}</time>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function groupByDay(activity: ActivityItem[]): Array<[string, ActivityItem[]]> {
  const groups = new Map<string, ActivityItem[]>();
  for (const item of activity) {
    const key = new Date(item.createdAt).toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.entries()];
}

function eventFamily(type: string): string {
  if (type.startsWith("approval")) return "approval";
  if (type.startsWith("task")) return "task";
  if (type.startsWith("tool")) return "tool";
  if (type.startsWith("runtime")) return "runtime";
  return "system";
}

function labelForType(type: string): string {
  return type.replaceAll(".", " ").replaceAll("_", " ");
}
