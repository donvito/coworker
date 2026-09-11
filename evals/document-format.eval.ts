import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { DesktopAppService } from "@main/app/app-service";
import { MemoryCredentialStore } from "@main/security/credential-store";
import { modelProviderCredentialKey } from "@shared/model-providers";
import { liveModel } from "./harness/model-transcript";

const model = liveModel();

interface TurnResult {
  input: string;
  result: string;
  tools: string[];
  skills: string[];
}

async function runTurn(
  service: DesktopAppService,
  conversationId: string,
  input: string,
): Promise<TurnResult> {
  const receipt = await service.sendConversationMessage({
    conversationId,
    clientMessageId: randomUUID(),
    content: input,
    mentionedCoworkerIds: [],
  });
  if (receipt.runs.length !== 1) {
    throw new Error(`Expected one coworker run for ${JSON.stringify(input)}`);
  }
  const taskId = receipt.runs[0]!.taskId;
  const deadline = Date.now() + 90_000;
  while (true) {
    const task = service.database.getTask(taskId);
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(task.status)) break;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${JSON.stringify(input)}`);
    await new Promise((done) => setTimeout(done, 25));
  }

  const task = service.database.getTask(taskId);
  const calls = service.database.listToolCalls(taskId);
  const skills = calls
    .filter((call) => call.toolName === "skills.read")
    .flatMap((call) => {
      const args = call.arguments as { name?: unknown };
      return typeof args.name === "string" ? [args.name] : [];
    });
  const turn = {
    input,
    result: task.result ?? "",
    tools: calls.map((call) => call.toolName),
    skills,
  };
  console.info(
    `[document-format-eval] ${JSON.stringify({
      input,
      reply: turn.result.slice(0, 500),
      tools: turn.tools,
      skills: turn.skills,
    })}`,
  );
  expect(task.status, `Task failed for: ${input}`).toBe("COMPLETED");
  expect(task.error, `Task error for: ${input}`).toBeNull();
  return turn;
}

function expectFormatConfirmation(result: string): void {
  expect(result).toMatch(/\bpdf\b/i);
  expect(result).toMatch(/\b(?:different|another|alternative|docx?|word|markdown|plain text|excel|xlsx|csv|powerpoint|pptx)\b/i);
  expect(result).toMatch(/\b(?:shall|would|prefer|choose|confirm|use)\b/i);
  expect(result).toContain("?");
}

describe.skipIf(!model)("live coworker document format behavior", () => {
  it("exports an explicitly requested PDF as a registered readable file", async () => {
    if (!model) throw new Error("Configure EVAL_PROVIDER, EVAL_MODEL and its API key");
    const root = await mkdtemp(join(tmpdir(), "coworker-explicit-pdf-eval-"));
    const credentials = new MemoryCredentialStore();
    await credentials.set(modelProviderCredentialKey(model.provider), model.apiKey);
    const service = new DesktopAppService({ dataPath: root, credentials, workerFactory: () => new Worker(resolve("out/main/runtime/coworker-worker.js")) });
    try {
      await service.initialize();
      const coworker = await service.createCoworker({ name: "PDF eval", role: "Writing assistant", systemPrompt: "You are Ava, a careful accounting coworker. Use controlled tools to create accurate artifacts. Never claim an external action happened unless its tool succeeded.", modelProvider: model.provider, modelName: model.id, enabledTools: ["files.write", "documents.export"] });
      const conversation = service.database.createConversation({ coworkerId: coworker.id });
      const turn = await runTurn(service, conversation.id, "Create a PDF file named poem.pdf containing a short poem about rain.");
      expect(turn.tools).toContain("documents.export");
      const artifacts = service.database.listArtifacts(coworker.id);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]!.name).toBe("poem.pdf");
      expect((await PDFDocument.load(await readFile(artifacts[0]!.filePath))).getPageCount()).toBeGreaterThan(0);
    } finally {
      await service.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("confirms saved PDF defaults, reuses chat content, and honors explicit DOCX", async () => {
    if (!model) throw new Error("Configure EVAL_PROVIDER, EVAL_MODEL and its API key");
    const root = await mkdtemp(join(tmpdir(), "coworker-document-format-eval-"));
    const credentials = new MemoryCredentialStore();
    await credentials.set(modelProviderCredentialKey(model.provider), model.apiKey);
    const service = new DesktopAppService({
      dataPath: root,
      credentials,
      workerFactory: () => new Worker(resolve("out/main/runtime/coworker-worker.js")),
    });

    try {
      await service.initialize();
      const coworker = await service.createCoworker({
        name: "Document format eval",
        role: "Writing assistant",
        systemPrompt:
          "You are Ava, a careful accounting coworker. Use controlled tools to create accurate artifacts. Never claim an external action happened unless its tool succeeded.",
        modelProvider: model.provider,
        modelName: model.id,
        enabledTools: ["files.write", "documents.export"],
      });
      await service.updateMemory(coworker.id, {
        content: "- Default document format: PDF",
        expectedRevision: (await service.readMemory(coworker.id)).revision,
      });
      const seededMemory = (await service.readMemory(coworker.id)).content;
      expect(seededMemory).toContain("Default document format: PDF");
      const noArtifacts = () => service.database.listArtifacts(coworker.id);

      const confirmationConversation = service.database.createConversation({
        coworkerId: coworker.id,
        title: "Format confirmation",
      });
      const draft = await runTurn(
        service,
        confirmationConversation.id,
        "make me a poem and add it to a file",
      );
      expect(draft.skills).toContain("document-authoring");
      expect(draft.tools).not.toContain("documents.export");
      expect(draft.tools).not.toContain("files.write");
      expect(noArtifacts()).toHaveLength(0);
      expectFormatConfirmation(draft.result);

      const accepted = await runTurn(
        service,
        confirmationConversation.id,
        "yes",
      );
      expect(accepted.tools.filter((tool) => tool === "documents.export")).toHaveLength(1);
      const pdfArtifacts = noArtifacts();
      expect(pdfArtifacts).toHaveLength(1);
      expect(pdfArtifacts[0]!.name).toMatch(/\.pdf$/i);
      expect(pdfArtifacts[0]!.mimeType).toBe("application/pdf");
      expect((await PDFDocument.load(await readFile(pdfArtifacts[0]!.filePath))).getPageCount()).toBeGreaterThan(0);

      const chatConversation = service.database.createConversation({
        coworkerId: coworker.id,
        title: "Creative chat then document",
      });
      const poem = await runTurn(
        service,
        chatConversation.id,
        "write me a short poem about rain",
      );
      expect(poem.skills).not.toContain("document-authoring");
      expect(poem.tools).not.toContain("documents.export");
      expect(poem.tools).not.toContain("files.write");
      expect(noArtifacts()).toHaveLength(1);

      const addPoem = await runTurn(
        service,
        chatConversation.id,
        "add to a doc",
      );
      expect(addPoem.skills).toContain("document-authoring");
      expect(addPoem.tools).not.toContain("documents.export");
      expect(addPoem.tools).not.toContain("files.write");
      expect(addPoem.result).not.toMatch(/(?:which|what)\s+(?:poem|content|text)|(?:provide|paste|send)\s+(?:me\s+)?(?:the|your)\s+(?:poem|content|text)/i);
      expectFormatConfirmation(addPoem.result);
      expect(noArtifacts()).toHaveLength(1);

      const alternate = await runTurn(service, chatConversation.id, "Word DOCX please");
      expect(alternate.tools.filter((tool) => tool === "documents.export")).toHaveLength(1);
      const alternateArtifact = noArtifacts().find((artifact) => /\.docx$/i.test(artifact.name));
      expect(alternateArtifact).toBeDefined();
      const archive = await JSZip.loadAsync(await readFile(alternateArtifact!.filePath));
      const xml = await archive.file("word/document.xml")!.async("string");
      const plainDocument = xml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").toLowerCase();
      // Verify the earlier poem survives the short follow-up, rather than
      // requiring the confirmation question to repeat its subject explicitly.
      const poemLines = poem.result.split(/\n/).map((line) => line.replace(/[*_#>]/g, "").trim()).filter((line) => line.split(/\s+/).length >= 4);
      expect(poemLines.some((line) => plainDocument.includes(line.toLowerCase()))).toBe(true);
      expect((await service.readMemory(coworker.id)).content).toBe(seededMemory);

      const rewriteConversation = service.database.createConversation({
        coworkerId: coworker.id,
        title: "Chat-only rewrite",
      });
      const rewrite = await runTurn(
        service,
        rewriteConversation.id,
        "Rewrite this email to sound friendlier: Please send me the update today.",
      );
      expect(rewrite.skills).not.toContain("document-authoring");
      expect(rewrite.tools).not.toContain("documents.export");
      expect(rewrite.tools).not.toContain("files.write");
      expect(noArtifacts()).toHaveLength(2);

      const explicitConversation = service.database.createConversation({
        coworkerId: coworker.id,
        title: "Explicit DOCX",
      });
      const docx = await runTurn(
        service,
        explicitConversation.id,
        "Create a fresh DOCX document containing a short poem about the ocean.",
      );
      expect(docx.tools.filter((tool) => tool === "documents.export")).toHaveLength(1);
      expect(docx.result).not.toMatch(/(?:what|which|choose)\s+(?:a\s+)?format/i);
      expect(docx.result).not.toMatch(/would you (?:like|prefer).*\b(?:pdf|docx|format)\b/i);
      const artifacts = noArtifacts();
      expect(artifacts).toHaveLength(3);
      const createdDocx = artifacts.find((artifact) => /\.docx$/i.test(artifact.name));
      expect(createdDocx).toEqual(
        expect.objectContaining({
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
      );
      // Preserve a pre-fix conversation where the assistant chose Markdown
      // without asking. The follow-up itself still runs against the live model.
      const legacyConversation = service.database.createConversation({ coworkerId: coworker.id, title: "Earlier unsolicited Markdown" });
      const legacyTask = service.database.createTask({ coworkerId: coworker.id, threadId: legacyConversation.id, title: "Earlier poem", input: "make me a poem and add it to a file" });
      const legacyPoem = "Silver rain on quiet streets,\nA thousand tiny silver beats.";
      await writeFile(join(coworker.workspacePath, "earlier-poem.md"), legacyPoem);
      service.database.addMessage({ coworkerId: coworker.id, taskId: legacyTask.id, role: "assistant", content: `I wrote your poem and saved it to earlier-poem.md. Here is the poem:\n${legacyPoem}` });
      service.database.setTaskStatus(legacyTask.id, "COMPLETED", { result: "Saved earlier-poem.md" });
      await new Promise((done) => setTimeout(done, 5));
      const legacyFollowUp = await runTurn(service, legacyConversation.id, "add to a doc");
      expect(legacyFollowUp.skills).toContain("document-authoring");
      expect(legacyFollowUp.tools).not.toContain("documents.export");
      expect(legacyFollowUp.tools).not.toContain("files.write");
      expectFormatConfirmation(legacyFollowUp.result);
      expect(noArtifacts()).toHaveLength(3);
      expect((await service.readMemory(coworker.id)).content).toBe(seededMemory);
      expect((await service.readMemory(coworker.id)).content).toBe(
        "- Default document format: PDF",
      );
    } finally {
      await service.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  }, 300_000);
});
