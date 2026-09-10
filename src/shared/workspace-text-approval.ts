import type { Approval } from "./contracts";
import { declaredWorkspaceContextFile } from "./workspace-context";

/** A presentation of a validated text proposal, shared by desktop and Telegram. */
export function workspaceTextApproval(approval: Pick<Approval, "actionType" | "proposedPayload">, payload = approval.proposedPayload) {
  if (!["files.edit", "files.write"].includes(approval.actionType) || !payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const args = payload as Record<string, unknown>;
  if (typeof args.path !== "string") return null;
  const context = declaredWorkspaceContextFile(args.path);
  const field = approval.actionType === "files.edit" ? "newText" : "content";
  const text = args[field];
  const oldText = approval.actionType === "files.edit" ? args.oldText : undefined;
  if (typeof text !== "string" || (approval.actionType === "files.edit" && typeof oldText !== "string")) return null;
  const label = context?.label ?? args.path;
  const operation = oldText === "" ? "append" : text === "" ? "remove" : "replace";
  return {
    path: args.path,
    label,
    title: operation === "append" ? `Add to ${label}` : operation === "remove" ? `Remove from ${label}` : `Update ${label}`,
    text,
    oldText: typeof oldText === "string" ? oldText : null,
    field,
    operation,
    maxCharacters: context?.maxCharacters ?? 5_000_000,
    requiresApproval: context?.requireApproval === true,
  } as const;
}

export function editedWorkspaceTextPayload(approval: Pick<Approval, "actionType" | "proposedPayload">, text: string): unknown {
  const proposal = workspaceTextApproval(approval);
  if (!proposal) throw new Error("This approval does not contain an editable text change.");
  if (text.length > proposal.maxCharacters) throw new Error(`Text must be at most ${proposal.maxCharacters} characters.`);
  return { ...approval.proposedPayload as Record<string, unknown>, [proposal.field]: text };
}

/** Approval edits may change the text, but must keep the reviewed target and revision. */
export function validateWorkspaceTextApprovalEdit(approval: Approval, payload: unknown): void {
  const original = workspaceTextApproval(approval);
  if (!original?.requiresApproval) return;
  const edited = workspaceTextApproval(approval, payload);
  const before = approval.proposedPayload as Record<string, unknown>;
  const after = payload as Record<string, unknown> | null;
  if (!edited || edited.path !== original.path || edited.oldText !== original.oldText || after?.expectedRevision !== before.expectedRevision) {
    throw new Error("Edit only the proposed text. The file, original text, and revision must stay unchanged.");
  }
}
