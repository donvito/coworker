// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Approval } from "@shared/contracts";
import { WorkspaceTextApprovalCard } from "@renderer/components/WorkspaceTextApprovalCard";

afterEach(() => cleanup());
const proposedPayload = { path: "MEMORY.md", oldText: "", newText: "- Reporting currency: SGD.\n", expectedRevision: "a".repeat(64) };
const approval: Approval = { id: "approval-1", taskId: "task-1", coworkerId: "coworker-1", toolCallId: "tool-1", actionType: "files.edit", summary: "Add to memory", proposedPayload, decidedPayload: null, riskLevel: "medium", status: "PENDING", createdAt: "2026-09-10T01:00:00Z", decidedAt: null };
function fixture(value = approval) {
  const decide = vi.fn().mockResolvedValue({ ...value, status: "APPROVED" });
  const onChanged = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, "coworker", { configurable: true, value: { approvals: { decide } } });
  render(<WorkspaceTextApprovalCard approval={value} coworkerName="Ava" onChanged={onChanged} />);
  return { decide, onChanged };
}

describe("inline text approval", () => {
  it("shows the proposed item and approves only when the user clicks", async () => {
    const { decide, onChanged } = fixture();
    expect(screen.getByText("- Reporting currency: SGD.")).toBeTruthy();
    expect(screen.queryByText(proposedPayload.expectedRevision)).toBeNull();
    expect(decide).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(decide).toHaveBeenCalledWith({ approvalId: approval.id, decision: "approve" });
  });

  it("lets the user edit the item inline while preserving its target and revision", async () => {
    const { decide } = fixture();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Proposed memory" }), { target: { value: "- Reporting currency: EUR.\n" } });
    expect(decide).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Approve edited text" }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith({ approvalId: approval.id, decision: "edit", payload: { ...proposedPayload, newText: "- Reporting currency: EUR.\n" } }));
  });

  it("retains edited text after a failed decision", async () => {
    const { decide } = fixture();
    decide.mockRejectedValueOnce(new Error("File changed since it was read."));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Proposed memory" }), { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve edited text" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Your edited text is kept");
    expect((screen.getByRole("textbox", { name: "Proposed memory" }) as HTMLTextAreaElement).value).toBe("Keep this draft");
    expect((screen.getByRole("button", { name: "Approve edited text" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("rejects without treating an edited draft as approved content", async () => {
    const { decide } = fixture();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Proposed memory" }), { target: { value: "Unsaved edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith({ approvalId: approval.id, decision: "reject" }));
  });

  it("shows the user-edited text in the resolved history", () => {
    fixture({ ...approval, status: "EDITED", decidedPayload: { ...proposedPayload, newText: "- Use EUR." } });
    expect(screen.getByText("- Use EUR.")).toBeTruthy();
    expect(screen.queryByText("- Reporting currency: SGD.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("shows exactly what a removal will delete", () => {
    fixture({ ...approval, proposedPayload: { ...proposedPayload, oldText: "- Old preference.", newText: "" } });
    expect(screen.getByText("Text to remove")).toBeTruthy();
    expect(screen.getByText("- Old preference.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
