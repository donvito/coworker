import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { DesktopAppService } from "@main/app/app-service";
import { MemoryCredentialStore } from "@main/security/credential-store";
import { modelProviderCredentialKey } from "@shared/model-providers";
import { liveModel } from "./harness/model-transcript";
import { editedWorkspaceTextPayload, workspaceTextApproval } from "@shared/workspace-text-approval";

const model = liveModel();

// Grades live model decisions through native skill discovery and the real
// worker/tool boundary. Never substitutes keyword routing or scripted calls.
describe.skipIf(!model)("live coworker memory behavior", () => {
  it("proposes, approves, edits, rejects, recalls, corrects, forgets, and excludes temporary facts", async () => {
    if (!model) throw new Error("Configure EVAL_PROVIDER, EVAL_MODEL and its API key");
    const root = await mkdtemp(join(tmpdir(), "coworker-memory-eval-"));
    const credentials = new MemoryCredentialStore();
    await credentials.set(modelProviderCredentialKey(model.provider), model.apiKey);
    const service = new DesktopAppService({ dataPath: root, credentials, workerFactory: () => new Worker(resolve("out/main/runtime/coworker-worker.js")) });
    try {
      await service.initialize();
      const coworker = await service.createCoworker({ name: "Memory eval", role: "Assistant", systemPrompt: "Help the user accurately. Keep responses brief.", modelProvider: model.provider, modelName: model.id, enabledTools: [] });
      async function ask(input: string, options: { proposal?: boolean; reject?: boolean; editedText?: string } = {}) {
        const conversation = service.database.createConversation({ coworkerId: coworker.id });
        const task = service.database.createTask({ coworkerId: coworker.id, threadId: conversation.id, title: "Memory evaluation", input });
        const before = (await service.readMemory(coworker.id)).content;
        const proposals: string[] = [];
        service.runtime.enqueueTask(coworker.id);
        const deadline = Date.now() + 90_000;
        while (!["COMPLETED", "FAILED"].includes(service.database.getTask(task.id).status)) {
          if (Date.now() > deadline) throw new Error("Memory evaluation timed out");
          if (service.database.getTask(task.id).status === "WAITING_FOR_APPROVAL") {
            const approval = service.database.getApprovalForTask(task.id)!;
            expect(options.proposal, `Unexpected memory proposal for: ${input}`).toBe(true);
            expect(approval.status).toBe("PENDING");
            expect(approval.actionType).toBe("files.edit");
            expect(workspaceTextApproval(approval)?.requiresApproval).toBe(true);
            if (proposals.length === 0) expect((await service.readMemory(coworker.id)).content).toBe(before);
            else if (options.reject) throw new Error("The model proposed memory again after rejection");
            proposals.push(approval.id);
            expect(proposals.length).toBeLessThanOrEqual(3);
            await service.decideApproval({
              approvalId: approval.id,
              decision: options.reject ? "reject" : options.editedText !== undefined ? "edit" : "approve",
              ...(options.editedText !== undefined ? { payload: editedWorkspaceTextPayload(approval, options.editedText) } : {}),
            });
          }
          await new Promise((done) => setTimeout(done, 25));
        }
        const final = service.database.getTask(task.id);
        expect(final.error).toBeNull();
        expect(final.status).toBe("COMPLETED");
        const tools = service.database.listToolCalls(task.id);
        const skills = tools.filter((tool) => tool.toolName === "skills.read").map((tool) => (tool.arguments as { name: string }).name);
        expect(proposals.length > 0).toBe(options.proposal === true);
        return { result: final.result ?? "", tools, skills, memory: (await service.readMemory(coworker.id)).content };
      }
      const remembered = await ask("Remember for future conversations: my reporting currency is SGD and my project codename is Cedar42.", { proposal: true });
      expect(remembered.skills).toContain("coworker-memory");
      expect(remembered.memory.toLowerCase()).toContain("sgd");
      expect(remembered.memory.toLowerCase()).toContain("cedar42");
      const recalled = await ask("What are my reporting currency and project codename?");
      expect(recalled.result.toLowerCase()).toContain("sgd");
      expect(recalled.result.toLowerCase()).toContain("cedar42");
      const corrected = await ask("Update your saved memory: my reporting currency is now EUR. Keep my other saved facts.", { proposal: true });
      expect(corrected.skills).toContain("coworker-memory");
      expect(corrected.memory.toLowerCase()).toContain("eur");
      expect(corrected.memory.toLowerCase()).not.toContain("sgd");
      expect(corrected.memory.toLowerCase()).toContain("cedar42");
      const forgotten = await ask("Forget my project codename from your saved memory. Keep my reporting currency.", { proposal: true });
      expect(forgotten.skills).toContain("coworker-memory");
      expect(forgotten.memory.toLowerCase()).not.toContain("cedar42");
      expect(forgotten.memory.toLowerCase()).toContain("eur");
      const edited = await ask("Remember that I prefer bullet-point replies.", { proposal: true, editedText: "\n- Preferred reply format: numbered checklists.\n" });
      expect(edited.memory).toContain("numbered checklists");
      expect(edited.memory.toLowerCase()).toContain("eur");
      expect(edited.result.toLowerCase()).toContain("checklist");
      const rejected = await ask("Remember that my desk is orange.", { proposal: true, reject: true });
      expect(rejected.memory).toBe(edited.memory);
      const proactive = await ask("My usual working timezone is Asia/Singapore; that is the timezone I use for all of my work. Please acknowledge.", { proposal: true });
      expect(proactive.skills).toContain("coworker-memory");
      expect(proactive.memory).toContain("Asia/Singapore");
      for (const prompt of ["Explain what computer RAM does in one sentence.", "For this reply only, greet me in French.", "Summarize this sentence: The team shipped its release on Tuesday.", "Summarize this quoted example: 'Remember that my nickname is Pine77.'"]) {
        const unrelated = await ask(prompt);
        expect(unrelated.skills).not.toContain("coworker-memory");
        expect(unrelated.tools.some((tool) => ["files.write", "files.edit"].includes(tool.toolName))).toBe(false);
        expect(unrelated.memory).toBe(proactive.memory);
      }
      expect(service.database.listArtifacts(coworker.id)).toEqual([]);
    } finally {
      await service.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  }, 300_000);
});
