import { useMemo, useState } from "react";
import type { Artifact, Coworker, Task } from "@shared/contracts";
import {
  ArtifactActions,
  artifactExtension,
  artifactKind,
} from "../components/ArtifactActions";
import { Icon } from "../components/Icon";
import {
  CoworkerAvatar,
  EmptyState,
  PageHeader,
  formatRelativeTime,
} from "../components/Primitives";

export function FilesPage({
  artifacts,
  coworkers,
  tasks,
  onOpenCoworker,
}: {
  artifacts: Artifact[];
  coworkers: Coworker[];
  tasks: Task[];
  onOpenCoworker: (coworker: Coworker) => void;
}) {
  const [query, setQuery] = useState("");
  const [coworkerId, setCoworkerId] = useState("all");
  const tasksById = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks],
  );
  const coworkersById = useMemo(
    () => new Map(coworkers.map((coworker) => [coworker.id, coworker])),
    [coworkers],
  );
  const sortedArtifacts = useMemo(
    () => [...artifacts].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [artifacts],
  );
  const normalizedQuery = query.trim().toLowerCase();
  const visibleArtifacts = sortedArtifacts.filter((artifact) => {
    if (coworkerId !== "all" && artifact.coworkerId !== coworkerId) return false;
    if (!normalizedQuery) return true;
    const coworker = coworkersById.get(artifact.coworkerId);
    const task = artifact.taskId ? tasksById.get(artifact.taskId) : undefined;
    return `${artifact.name} ${artifact.mimeType} ${coworker?.name ?? ""} ${task?.title ?? ""}`
      .toLowerCase()
      .includes(normalizedQuery);
  });
  const groups = coworkers.flatMap((coworker) => {
    const files = visibleArtifacts.filter((artifact) => artifact.coworkerId === coworker.id);
    return files.length > 0 ? [{ coworker, files }] : [];
  });
  const contributingCoworkers = new Set(artifacts.map((artifact) => artifact.coworkerId)).size;
  const latestArtifact = sortedArtifacts[0];
  const latestCoworker = latestArtifact
    ? coworkersById.get(latestArtifact.coworkerId)
    : undefined;

  return (
    <div className="page files-page">
      <PageHeader
        eyebrow="Local library"
        title="Files"
        description="Everything your coworkers create, organized by owner and kept on this computer."
      />

      <section className="files-ledger" aria-label="File library summary">
        <span>
          <strong>{artifacts.length}</strong>
          <small>local file{artifacts.length === 1 ? "" : "s"}</small>
        </span>
        <span>
          <strong>{contributingCoworkers}</strong>
          <small>coworker{contributingCoworkers === 1 ? "" : "s"} contributing</small>
        </span>
        <span>
          <strong>{latestArtifact ? formatRelativeTime(latestArtifact.createdAt) : "—"}</strong>
          <small>{latestCoworker ? `latest from ${latestCoworker.name}` : "no files created"}</small>
        </span>
        <p>
          <Icon name="shield" />
          One local library, shared across coworker file views
        </p>
      </section>

      <div className="files-toolbar">
        <label className="files-search">
          <Icon name="search" />
          <input
            aria-label="Search files"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search files or tasks"
            value={query}
          />
        </label>
        <label className="files-owner-filter">
          <span>Created by</span>
          <select
            aria-label="Filter files by coworker"
            onChange={(event) => setCoworkerId(event.target.value)}
            value={coworkerId}
          >
            <option value="all">All coworkers</option>
            {coworkers.map((coworker) => (
              <option key={coworker.id} value={coworker.id}>
                {coworker.name}
              </option>
            ))}
          </select>
        </label>
        <small>
          Showing {visibleArtifacts.length} of {artifacts.length}
        </small>
      </div>

      {groups.length > 0 ? (
        <div className="file-owner-groups">
          {groups.map(({ coworker, files }) => (
            <section className="file-owner-group" key={coworker.id}>
              <header>
                <button onClick={() => onOpenCoworker(coworker)} type="button">
                  <CoworkerAvatar className="file-owner-avatar" coworker={coworker} />
                  <span>
                    <strong>{coworker.name}</strong>
                    <small>{coworker.role}</small>
                  </span>
                  <Icon name="arrow" />
                </button>
                <span>
                  {files.length} file{files.length === 1 ? "" : "s"}
                </span>
              </header>
              <div className="file-library-list">
                {files.map((artifact) => {
                  const task = artifact.taskId ? tasksById.get(artifact.taskId) : undefined;
                  return (
                    <article className="file-library-row" key={artifact.id}>
                      <span className="file-library-icon">
                        <Icon name="file" />
                        <small>{artifactExtension(artifact)}</small>
                      </span>
                      <div className="file-library-copy">
                        <strong title={artifact.name}>{artifact.name}</strong>
                        <small>
                          {artifactKind(artifact)} · {formatRelativeTime(artifact.createdAt)}
                        </small>
                        {task ? <p>{task.title}</p> : null}
                      </div>
                      <ArtifactActions
                        allowDelete
                        target={{ id: artifact.id, name: artifact.name }}
                      />
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <EmptyState
          icon="file"
          title={artifacts.length === 0 ? "No files yet" : "No files match"}
          body={
            artifacts.length === 0
              ? "Files created by your coworkers will appear here automatically."
              : "Change the coworker filter or try a different search."
          }
        />
      )}
    </div>
  );
}
