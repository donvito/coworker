import { useEffect, useState, type FormEvent } from "react";
import type { Approval, Coworker } from "@shared/contracts";
import { Icon } from "../components/Icon";
import {
  EmptyState,
  PageHeader,
  StatusLabel,
  formatRelativeTime,
  initials,
} from "../components/Primitives";

export function ApprovalsPage({
  approvals,
  coworkers,
  onChanged,
}: {
  approvals: Approval[];
  coworkers: Coworker[];
  onChanged: () => Promise<void>;
}) {
  const pending = approvals.filter((approval) => approval.status === "PENDING");
  const history = approvals.filter((approval) => approval.status !== "PENDING");
  const [selected, setSelected] = useState<Approval | null>(pending[0] ?? null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (selected) {
      const current = approvals.find((approval) => approval.id === selected.id);
      if (current) setSelected(current);
    } else if (pending[0]) {
      setSelected(pending[0]);
    }
  }, [approvals]);

  async function decide(
    approval: Approval,
    decision: "approve" | "reject" | "edit",
    payload?: unknown,
  ) {
    setWorking(true);
    setError(null);
    try {
      await window.coworker.approvals.decide({
        approvalId: approval.id,
        decision,
        payload,
      });
      setSelected(null);
      await onChanged();
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : String(decisionError));
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="page approvals-page">
      <PageHeader
        eyebrow="Human checkpoint"
        title="Approvals"
        description="The model can propose consequential work. Only this durable queue can authorize it."
      />

      <div className="approval-summary-strip">
        <span>
          <strong>{pending.length}</strong>
          <small>Waiting</small>
        </span>
        <span>
          <strong>
            {approvals.filter((approval) => ["APPROVED", "EDITED"].includes(approval.status)).length}
          </strong>
          <small>Approved</small>
        </span>
        <span>
          <strong>{approvals.filter((approval) => approval.status === "REJECTED").length}</strong>
          <small>Rejected</small>
        </span>
        <p>
          <Icon name="shield" /> Decisions are written to SQLite before work resumes.
        </p>
      </div>

      {pending.length === 0 ? (
        <EmptyState
          icon="check"
          title="The decision queue is clear"
          body="External sends and other gated actions will pause here until you review them."
        />
      ) : (
        <div className="approval-list">
          {pending.map((approval) => {
            const coworker = coworkers.find((item) => item.id === approval.coworkerId);
            const payload = emailPayload(approval.proposedPayload);
            return (
              <article className="approval-card" key={approval.id}>
                <div className="approval-card-head">
                  <span className="decision-avatar">{initials(coworker?.name ?? "?")}</span>
                  <span>
                    <small>
                      {coworker?.name ?? "Coworker"} · {coworker?.role ?? "Coworker"}
                    </small>
                    <h2>{approval.summary}</h2>
                  </span>
                  <span className={`risk-chip risk-${approval.riskLevel}`}>
                    {approval.riskLevel} risk
                  </span>
                </div>
                {payload ? (
                  <div className="email-preview">
                    <span>
                      <small>To</small>
                      <strong>{Array.isArray(payload.to) ? payload.to.join(", ") : payload.to}</strong>
                    </span>
                    <span>
                      <small>Subject</small>
                      <strong>{payload.subject}</strong>
                    </span>
                    <p>{payload.body}</p>
                    {payload.attachments?.length ? (
                      <div className="attachment-chips">
                        {payload.attachments.map((attachment) => (
                          <span key={attachment}>
                            <Icon name="file" /> {attachment}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <pre className="payload-preview">
                    {JSON.stringify(approval.proposedPayload, null, 2)}
                  </pre>
                )}
                <div className="approval-card-foot">
                  <span>Requested {formatRelativeTime(approval.createdAt)}</span>
                  <div>
                    <button
                      className="ghost-button danger"
                      disabled={working}
                      onClick={() => void decide(approval, "reject")}
                    >
                      Reject
                    </button>
                    <button
                      className="secondary-button"
                      disabled={working}
                      onClick={() => setSelected(approval)}
                    >
                      Review & edit
                    </button>
                    <button
                      className="primary-button"
                      disabled={working}
                      onClick={() => void decide(approval, "approve")}
                    >
                      <Icon name="check" /> Approve
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {history.length > 0 ? (
        <section className="approval-history">
          <div className="section-heading compact">
            <div>
              <span className="eyebrow">Audit trail</span>
              <h2>Recent decisions</h2>
            </div>
          </div>
          {history.slice(0, 20).map((approval) => {
            const coworker = coworkers.find((item) => item.id === approval.coworkerId);
            return (
              <div className="history-row" key={approval.id}>
                <span className="decision-avatar small">{initials(coworker?.name ?? "?")}</span>
                <span>
                  <strong>{approval.summary}</strong>
                  <small>
                    {coworker?.name} · {formatRelativeTime(approval.decidedAt)}
                  </small>
                </span>
                <StatusLabel
                  status={
                    approval.status === "EDITED"
                      ? "APPROVED"
                      : (approval.status as "APPROVED" | "REJECTED")
                  }
                />
              </div>
            );
          })}
        </section>
      ) : null}

      {selected?.status === "PENDING" ? (
        <ApprovalEditor
          approval={selected}
          working={working}
          error={error}
          onClose={() => setSelected(null)}
          onSave={(payload) => void decide(selected, "edit", payload)}
        />
      ) : null}
    </div>
  );
}

interface EmailShape {
  to: string | string[];
  subject: string;
  body: string;
  attachments?: string[];
}

function emailPayload(value: unknown): EmailShape | null {
  if (!value || typeof value !== "object") return null;
  if (!("to" in value) || !("subject" in value) || !("body" in value)) return null;
  return value as EmailShape;
}

function ApprovalEditor({
  approval,
  working,
  error,
  onClose,
  onSave,
}: {
  approval: Approval;
  working: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (payload: unknown) => void;
}) {
  const payload = emailPayload(approval.proposedPayload);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!payload) {
      onSave(approval.proposedPayload);
      return;
    }
    const data = new FormData(event.currentTarget);
    onSave({
      ...payload,
      to: String(data.get("to") ?? "")
        .split(",")
        .map((address) => address.trim())
        .filter(Boolean),
      subject: String(data.get("subject") ?? ""),
      body: String(data.get("body") ?? ""),
    });
  }
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        className="modal-card review-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-approval-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="eyebrow">Review checkpoint</span>
        <h2 id="review-approval-title">{approval.summary}</h2>
        <p>Changes are saved with the decision and become the payload that executes.</p>
        <form className="form-stack" onSubmit={submit}>
          {payload ? (
            <>
              <label>
                <span>Recipients</span>
                <input
                  name="to"
                  defaultValue={Array.isArray(payload.to) ? payload.to.join(", ") : payload.to}
                  required
                />
              </label>
              <label>
                <span>Subject</span>
                <input name="subject" defaultValue={payload.subject} required />
              </label>
              <label>
                <span>Message</span>
                <textarea name="body" defaultValue={payload.body} rows={10} required />
              </label>
            </>
          ) : (
            <pre className="payload-preview">
              {JSON.stringify(approval.proposedPayload, null, 2)}
            </pre>
          )}
          {error ? <div className="inline-error">{error}</div> : null}
          <div className="modal-actions">
            <button className="secondary-button" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary-button" disabled={working}>
              {working ? "Saving…" : "Approve changes"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
