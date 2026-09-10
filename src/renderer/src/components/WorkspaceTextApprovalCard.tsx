import { useEffect, useState } from "react";
import type { Approval } from "@shared/contracts";
import { editedWorkspaceTextPayload, workspaceTextApproval } from "@shared/workspace-text-approval";
import { Icon } from "./Icon";

export function WorkspaceTextApprovalCard({ approval, coworkerName, onChanged }: {
  approval: Approval;
  coworkerName: string;
  onChanged: () => Promise<void>;
}) {
  const proposal = workspaceTextApproval(approval);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(proposal?.text ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setText(proposal?.text ?? ""); setEditing(false); setError(null); }, [approval.id, proposal?.text]);
  if (!proposal) return null;
  const pending = approval.status === "PENDING";
  const decided = approval.status === "EDITED" ? workspaceTextApproval(approval, approval.decidedPayload) : proposal;
  const shown = pending ? proposal : decided ?? proposal;

  async function decide(decision: "approve" | "edit" | "reject") {
    setBusy(true);
    setError(null);
    try {
      await window.coworker.approvals.decide({
        approvalId: approval.id,
        decision,
        ...(decision === "edit" ? { payload: editedWorkspaceTextPayload(approval, text) } : {}),
      });
      await onChanged();
      setEditing(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  }

  return (
    <article className="workroom-approval workspace-text-approval" aria-label={proposal.title}>
      <header>
        <span className="workroom-approval-icon"><Icon name={pending ? "shield" : approval.status === "REJECTED" ? "stop" : "check"} /></span>
        <span>
          <small>{coworkerName} · {pending ? "Approval required" : approval.status === "EDITED" ? "Edited and approved" : approval.status.toLowerCase()}</small>
          <strong>{proposal.title}</strong>
        </span>
      </header>
      {shown.oldText ? (
        <div className="workspace-text-approval-item">
          <small>{shown.text ? "Current text" : "Text to remove"}</small>
          <pre>{shown.oldText}</pre>
        </div>
      ) : null}
      {editing && pending ? (
        <label className="workspace-text-approval-item">
          <span>Proposed {proposal.label}</span>
          <textarea aria-label={`Proposed ${proposal.label}`} value={text} onChange={(event) => setText(event.target.value)} rows={5} maxLength={proposal.maxCharacters} disabled={busy} />
          <small>{text.length.toLocaleString()} / {proposal.maxCharacters.toLocaleString()} characters</small>
        </label>
      ) : shown.text ? (
        <div className="workspace-text-approval-item">
          <small>{pending ? "Proposed text" : "Reviewed text"}</small>
          <pre>{shown.text}</pre>
        </div>
      ) : <p>This change removes the text above.</p>}
      {pending ? <small>{proposal.oldText === null ? "This replaces the entire saved file. " : ""}Nothing is saved until you approve.</small> : null}
      {error ? <div className="inline-error" role="alert">{error} {editing ? "Your edited text is kept." : ""}</div> : null}
      {pending ? (
        <div className="workroom-approval-actions">
          <button className="quick-approve-button" type="button" disabled={busy || (editing && proposal.oldText === "" && !text.trim())} onClick={() => void decide(editing ? "edit" : "approve")}>
            <Icon name="check" />{busy ? "Saving decision…" : editing ? "Approve edited text" : "Approve"}
          </button>
          <button className="quick-review-button" type="button" disabled={busy} onClick={() => { setEditing(!editing); setText(proposal.text); setError(null); }}>
            {editing ? "Cancel edit" : "Edit"}
          </button>
          <button className="workroom-approval-reject" type="button" disabled={busy} onClick={() => void decide("reject")}>Reject</button>
        </div>
      ) : null}
    </article>
  );
}
