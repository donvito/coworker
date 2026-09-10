import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAppService } from "@main/app/app-service";
import { MemoryCredentialStore } from "@main/security/credential-store";
import { editWorkspaceText, readWorkspaceText, resolveWorkspaceOutputPath, writeWorkspaceText } from "@main/tools/workspace-text";
import { editedWorkspaceTextPayload, workspaceTextApproval } from "@shared/workspace-text-approval";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "coworker-text-approval-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const service = new DesktopAppService({ dataPath: root, credentials: new MemoryCredentialStore() });
  cleanups.push(() => service.shutdown());
  await service.initialize();
  vi.spyOn(service.runtime, "enqueueTask").mockImplementation(() => undefined);
  const coworker = service.database.listCoworkers()[0]!;
  let calls = 0;
  const propose = async (args: unknown, toolName = "files.edit", policy: "automatic" | "approval" | "denied" = "automatic") => {
    const task = service.database.createTask({ coworkerId: coworker.id, title: "Propose a text change", input: "Remember my preference" });
    return service.tools.request({ task, coworker: { ...coworker, policies: { [toolName]: policy } }, toolName, toolCallId: `proposal-${++calls}`, arguments: args });
  };
  const store = async (content: string) => service.updateMemory(coworker.id, { content, expectedRevision: (await service.readMemory(coworker.id)).revision });
  return { service, coworker, propose, store };
}

describe("reviewed workspace text changes", () => {
  it("requires approval even under automatic policy, then applies only the user-edited item", async () => {
    const { service, coworker, propose, store } = await fixture();
    const initial = await store("- Keep the existing project name.\n");
    const result = await propose({ path: "./memory.md", oldText: "", newText: "- Reporting currency: SGD.\n", expectedRevision: initial.revision });
    expect(result.kind).toBe("approval");
    if (result.kind !== "approval") throw new Error("Approval missing");
    expect(result.approval.proposedPayload).toMatchObject({ path: "MEMORY.md" });
    expect(workspaceTextApproval(result.approval)).toMatchObject({ title: "Add to memory", text: "- Reporting currency: SGD.\n", requiresApproval: true });
    expect((await service.readMemory(coworker.id)).content).toBe(initial.content);
    const approved = await service.decideApproval({ approvalId: result.approval.id, decision: "edit", payload: editedWorkspaceTextPayload(result.approval, "- Reporting currency: EUR.\n") });
    expect(approved.status).toBe("EDITED");
    expect((await service.readMemory(coworker.id)).content).toBe(initial.content); // decision is durable before execution
    const execution = await service.tools.executeApproval(approved, coworker);
    expect(execution.result).toMatchObject({ appliedText: "- Reporting currency: EUR.\n" });
    expect((await service.readMemory(coworker.id)).content).toBe(initial.content + "- Reporting currency: EUR.\n");
    expect(service.database.listArtifacts(coworker.id)).toEqual([]);
    expect(service.database.listActivity().some(item => item.type === "approval.edited")).toBe(true);
    await store("- A later user edit.\n");
    await service.tools.executeApproval(approved, coworker);
    expect((await service.readMemory(coworker.id)).content).toBe("- A later user edit.\n");
  });

  it("protects corrections, removals, whole-file writes, and aliases without gating ordinary files", async () => {
    const { service, coworker, propose, store } = await fixture();
    const initial = await store("- Use SGD.\n- Keep this fact.\n");
    await symlink(join(coworker.workspacePath, "MEMORY.md"), join(coworker.workspacePath, "alias.md"));
    for (const path of ["MEMORY.md", "memory.md", "alias.md"]) {
      const result = await propose({ path, content: "overwritten", expectedRevision: initial.revision }, "files.write");
      expect(result.kind).toBe("approval");
      if (result.kind !== "approval") throw new Error("Approval missing");
      expect(result.approval.proposedPayload).toMatchObject({ path: "MEMORY.md" });
    }
    const correction = await propose({ path: "MEMORY.md", oldText: "- Use SGD.\n", newText: "- Use EUR.\n", expectedRevision: initial.revision });
    if (correction.kind !== "approval") throw new Error("Approval missing");
    await service.tools.executeApproval(await service.decideApproval({ approvalId: correction.approval.id, decision: "approve" }), coworker);
    const current = await service.readMemory(coworker.id);
    expect(current.content).toBe("- Use EUR.\n- Keep this fact.\n");
    const removal = await propose({ path: "MEMORY.md", oldText: "- Use EUR.\n", newText: "", expectedRevision: current.revision });
    if (removal.kind !== "approval") throw new Error("Approval missing");
    const rejected = await service.decideApproval({ approvalId: removal.approval.id, decision: "reject" });
    expect(await service.tools.executeApproval(rejected, coworker)).toMatchObject({ approved: false });
    expect((await service.readMemory(coworker.id)).content).toBe(current.content);
    expect(await propose({ path: "notes.md", content: "A regular document" }, "files.write")).toMatchObject({ kind: "completed" });
    const notes = await readWorkspaceText(coworker.workspacePath, "notes.md");
    const documentEdit = await propose({ path: "notes.md", oldText: "regular", newText: "revised", expectedRevision: notes.revision });
    expect(documentEdit).toMatchObject({ kind: "completed", result: { artifactId: expect.any(String), appliedText: "revised" } });
    const denied = await propose({ path: "MEMORY.md", oldText: "", newText: "No", expectedRevision: current.revision }, "files.edit", "denied");
    expect(denied.kind).toBe("denied");
    await expect(writeWorkspaceText(coworker.workspacePath, "alias.md", "bypass", current.revision, { approvedContextPath: null })).rejects.toThrow("requires approval");
  });

  it("blocks exporter aliases and requires approval when memory points to another workspace file", async () => {
    const { service, coworker, propose, store } = await fixture();
    const initial = await store("- Keep this memory.\n");
    await symlink(join(coworker.workspacePath, "MEMORY.md"), join(coworker.workspacePath, "report.csv"));
    await expect(resolveWorkspaceOutputPath(coworker.workspacePath, "report.csv")).rejects.toThrow("reviewed text change");
    await expect(propose({ name: "report", content: "| Item |\n| --- |\n| overwrite |", formats: ["csv"] }, "documents.export")).rejects.toThrow("reviewed text change");
    expect((await service.readMemory(coworker.id)).content).toBe(initial.content);
    await rm(join(coworker.workspacePath, "MEMORY.md"));
    await writeWorkspaceText(coworker.workspacePath, "saved-notes.txt", initial.content);
    await symlink(join(coworker.workspacePath, "saved-notes.txt"), join(coworker.workspacePath, "MEMORY.md"));
    const result = await propose({ path: "saved-notes.txt", oldText: "", newText: "- New fact.\n", expectedRevision: initial.revision });
    expect(result).toMatchObject({ kind: "approval", approval: { proposedPayload: { path: "MEMORY.md" } } });
    await expect(resolveWorkspaceOutputPath(coworker.workspacePath, "saved-notes.txt")).rejects.toThrow("reviewed text change");
    expect((await service.readMemory(coworker.id)).content).toBe(initial.content);
  });

  it("keeps invalid, retargeted, oversized, or stale approval edits pending and preserves saved data", async () => {
    const { service, coworker, propose, store } = await fixture();
    const initial = await store("x".repeat(7_990));
    const result = await propose({ path: "MEMORY.md", oldText: "", newText: "123", expectedRevision: initial.revision });
    if (result.kind !== "approval") throw new Error("Approval missing");
    const original = result.approval.proposedPayload as Record<string, unknown>;
    for (const patch of [{ path: "notes.md" }, { oldText: "x" }, { expectedRevision: "0".repeat(64) }, { newText: "y".repeat(11) }, { newText: "\ud800" }]) {
      await expect(service.decideApproval({ approvalId: result.approval.id, decision: "edit", payload: { ...original, ...patch } })).rejects.toThrow();
      expect(service.database.getApproval(result.approval.id).status).toBe("PENDING");
    }
    await store("Changed while awaiting approval.");
    await expect(service.decideApproval({ approvalId: result.approval.id, decision: "approve" })).rejects.toThrow("changed since");
    expect(service.database.getApproval(result.approval.id).status).toBe("PENDING");
    expect((await service.readMemory(coworker.id)).content).toBe("Changed while awaiting approval.");
    await service.decideApproval({ approvalId: result.approval.id, decision: "reject" });
  });

  it("applies literal unique replacements and serializes revision-checked edits", async () => {
    const { coworker } = await fixture();
    await writeWorkspaceText(coworker.workspacePath, "notes.md", "first\nsecond\n");
    const initial = await readWorkspaceText(coworker.workspacePath, "notes.md");
    const edited = await editWorkspaceText(coworker.workspacePath, { path: "notes.md", oldText: "first", newText: "$& 中文", expectedRevision: initial.revision });
    expect(edited.content).toBe("$& 中文\nsecond\n");
    const results = await Promise.allSettled(["A", "B"].map(newText => editWorkspaceText(coworker.workspacePath, { path: "notes.md", oldText: "second", newText, expectedRevision: edited.revision })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    await writeWorkspaceText(coworker.workspacePath, "notes.md", "repeated repeated");
    const repeated = await readWorkspaceText(coworker.workspacePath, "notes.md");
    for (const oldText of ["repeated", "missing"]) await expect(editWorkspaceText(coworker.workspacePath, { path: "notes.md", oldText, newText: "other", expectedRevision: repeated.revision })).rejects.toThrow();
    expect((await readWorkspaceText(coworker.workspacePath, "notes.md")).content).toBe(repeated.content);
  });
});
