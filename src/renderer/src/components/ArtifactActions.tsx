import { useState } from "react";
import type { Artifact } from "@shared/contracts";
import { Icon } from "./Icon";

export interface ArtifactTarget {
  id: string;
  name: string;
}

export function ArtifactActions({
  target,
  allowDelete = false,
}: {
  target: ArtifactTarget;
  allowDelete?: boolean;
}) {
  const [pendingAction, setPendingAction] = useState<"open" | "download" | "delete" | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; error: boolean } | null>(null);

  async function act(action: "open" | "download" | "delete") {
    setPendingAction(action);
    setFeedback(null);
    try {
      if (action === "open") {
        await window.coworker.artifacts.open(target.id);
        setFeedback({ message: "Opened", error: false });
      } else if (action === "download") {
        const destination = await window.coworker.artifacts.download(target.id);
        if (destination) setFeedback({ message: "Downloaded", error: false });
      } else {
        await window.coworker.artifacts.remove(target.id);
        setDeleted(true);
        setFeedback({ message: "Deleted", error: false });
      }
    } catch (error) {
      setFeedback({
        message: error instanceof Error ? error.message : String(error),
        error: true,
      });
    } finally {
      if (action === "delete") setConfirmingDelete(false);
      setPendingAction(null);
    }
  }

  if (deleted) {
    return (
      <span className="artifact-actions artifact-deleted" role="status">
        <Icon name="trash" />
        <small>Deleted</small>
      </span>
    );
  }

  return (
    <span className="artifact-actions">
      {confirmingDelete ? (
        <span className="artifact-delete-confirm">
          <small title={`Delete ${target.name} from every file view?`}>
            Delete “{target.name}” everywhere?
          </small>
          <button
            disabled={pendingAction !== null}
            onClick={() => setConfirmingDelete(false)}
            type="button"
          >
            Keep
          </button>
          <button
            className="danger"
            disabled={pendingAction !== null}
            onClick={() => void act("delete")}
            type="button"
          >
            <Icon name="trash" />
            {pendingAction === "delete" ? "Deleting…" : "Delete"}
          </button>
        </span>
      ) : (
        <>
          <button
            aria-label={`Open ${target.name}`}
            disabled={pendingAction !== null}
            onClick={() => void act("open")}
            title="Open with the default app"
            type="button"
          >
            <Icon name="open" />
            {pendingAction === "open" ? "Opening…" : "Open"}
          </button>
          <button
            aria-label={`Download ${target.name}`}
            disabled={pendingAction !== null}
            onClick={() => void act("download")}
            title="Download a copy"
            type="button"
          >
            <Icon name="download" />
            {pendingAction === "download" ? "Saving…" : "Download"}
          </button>
          {allowDelete ? (
            <button
              aria-label={`Delete ${target.name}`}
              className="artifact-delete-trigger"
              disabled={pendingAction !== null}
              onClick={() => {
                setFeedback(null);
                setConfirmingDelete(true);
              }}
              title={`Delete ${target.name} from every file view`}
              type="button"
            >
              <Icon name="trash" />
              Delete
            </button>
          ) : null}
        </>
      )}
      {feedback ? (
        <small
          className={feedback.error ? "artifact-action-status error" : "artifact-action-status"}
          role="status"
          title={feedback.message}
        >
          {feedback.message}
        </small>
      ) : null}
    </span>
  );
}

export function artifactExtension(artifact: Artifact): string {
  const extension = artifact.name.split(".").at(-1);
  if (extension && extension !== artifact.name) return extension.toUpperCase().slice(0, 5);
  if (artifact.mimeType === "application/pdf") return "PDF";
  return "FILE";
}

export function artifactKind(artifact: Artifact): string {
  if (artifact.mimeType === "application/pdf") return "PDF document";
  if (artifact.mimeType.includes("wordprocessingml")) return "Word document";
  if (artifact.mimeType === "text/markdown") return "Markdown";
  if (artifact.mimeType === "message/rfc822") return "Email draft";
  if (artifact.mimeType.startsWith("text/")) return "Text document";
  return "File";
}
