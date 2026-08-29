import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserAutomationService } from "@main/integrations/browser-automation";
import { CoworkerDatabase } from "@main/db/database";
import {
  bundledBrowserComputerUseSkill,
  parseSkillMarkdown,
} from "@main/integrations/skills";
import { MemoryCredentialStore } from "@main/security/credential-store";
import { ToolGateway } from "@main/tools/tool-gateway";
import {
  defaultEnabledBundledSkillNames,
  toolNamesForSkills,
} from "@shared/skill-capabilities";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("browser computer-use skill", () => {
  it("is narrowly routed, opt-in, and declares its controlled tools", () => {
    const skill = parseSkillMarkdown(bundledBrowserComputerUseSkill.content);
    expect(skill.description).toContain("interact with web pages");
    expect(skill.description).toContain("Do not use for ordinary web research");
    expect(defaultEnabledBundledSkillNames.has(skill.name)).toBe(false);
    expect(toolNamesForSkills([skill])).toEqual([
      "browser.start_session",
      "browser.inspect",
      "browser.act",
      "browser.close",
    ]);
  });

  it("requires one approval, controls a real page, and redacts filled values", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-browser-"));
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath);
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html>
        <html><head><title>Browser fixture</title></head><body>
          <label>Name <input aria-label="Name" /></label>
          <label>Password <input aria-label="Password" type="password" /></label>
          <button onclick="document.querySelector('#status').textContent = 'Saved'">Save</button>
          <p id="status">Waiting</p>
        </body></html>`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not start");

    const database = new CoworkerDatabase(":memory:");
    const browser = new BrowserAutomationService(root, { headless: true });
    cleanups.push(async () => {
      await browser.closeAll();
      database.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    });
    const skill = database.upsertSkill(bundledBrowserComputerUseSkill);
    const coworker = database.createCoworker(
      {
        name: "Browser coworker",
        role: "Web operator",
        systemPrompt: "Use the controlled browser carefully.",
        modelProvider: "demo",
        modelName: "faux-1",
        enabledTools: [],
        enabledSkillIds: [skill.id],
      },
      workspacePath,
    );
    const task = database.createTask({
      coworkerId: coworker.id,
      title: "Use fixture",
      input: "Enter a name and save it.",
    });
    const gateway = new ToolGateway(
      database,
      new MemoryCredentialStore(),
      join(root, "outbox"),
      { browser },
    );

    const requested = await gateway.request({
      task,
      coworker,
      toolCallId: "browser-start",
      toolName: "browser.start_session",
      arguments: {
        goal: "Enter a name and save it",
        startUrl: `http://127.0.0.1:${address.port}`,
      },
    });
    expect(requested.kind).toBe("approval");
    if (requested.kind !== "approval") return;
    const approved = database.decideApproval({
      approvalId: requested.approval.id,
      decision: "approve",
    });
    await gateway.executeApproval(approved, coworker);

    const inspected = await gateway.request({
      task,
      coworker,
      toolCallId: "browser-inspect",
      toolName: "browser.inspect",
      arguments: {},
    });
    expect(inspected.kind).toBe("completed");
    if (inspected.kind === "completed") {
      expect(inspected.result).toMatchObject({
        __coworkerRichToolResult: true,
        details: {
          title: "Browser fixture",
          accessibility: expect.stringContaining("Name"),
        },
      });
    }

    await gateway.request({
      task,
      coworker,
      toolCallId: "browser-fill",
      toolName: "browser.act",
      arguments: {
        action: {
          kind: "fill",
          target: { by: "label", value: "Name" },
          value: "Sensitive form value",
        },
      },
    });
    const clicked = await gateway.request({
      task,
      coworker,
      toolCallId: "browser-click",
      toolName: "browser.act",
      arguments: {
        action: { kind: "click", target: { by: "role", role: "button", name: "Save" } },
      },
    });
    expect(clicked.kind).toBe("completed");
    if (clicked.kind === "completed") {
      expect(clicked.result).toMatchObject({
        details: { accessibility: expect.stringContaining("Saved") },
      });
    }
    const fillCall = database.listToolCalls().find((call) => call.toolName === "browser.act");
    expect(JSON.stringify(fillCall?.arguments)).not.toContain("Sensitive form value");
    expect(JSON.stringify(fillCall?.arguments)).toContain("redacted");

    await expect(
      gateway.request({
        task,
        coworker,
        toolCallId: "browser-password",
        toolName: "browser.act",
        arguments: {
          action: {
            kind: "fill",
            target: { by: "label", value: "Password" },
            value: "do-not-enter-this",
          },
        },
      }),
    ).rejects.toThrow("Passwords must be entered by the user");
  }, 30_000);
});
