import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderErrorLogger } from "@main/runtime/provider-error-logger";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("provider error diagnostics", () => {
  it("writes structured JSONL and redacts credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-provider-log-"));
    temporaryPaths.push(root);
    const path = join(root, "logs", "provider-errors.jsonl");
    const logger = new ProviderErrorLogger(path);
    const secret = "sk-or-v1-supersecretcredential123456";

    await logger.log(
      {
        phase: "inference",
        provider: "openrouter",
        model: "google/gemini-test",
        coworkerId: "coworker-1",
        taskId: "task-1",
        runId: "run-1",
      },
      new Error(
        `404: no endpoint; Authorization: Bearer ${secret}; api_key=${secret}; /Users/alice/private/app.js`,
      ),
    );

    const contents = await readFile(path, "utf8");
    expect(contents).not.toContain(secret);
    const record = JSON.parse(contents.trim()) as Record<string, unknown>;
    expect(record).toMatchObject({
      level: "error",
      category: "model_provider",
      phase: "inference",
      provider: "openrouter",
      model: "google/gemini-test",
      coworkerId: "coworker-1",
      taskId: "task-1",
      runId: "run-1",
      status: 404,
    });
    expect(String(record.message)).toContain("[REDACTED]");
    expect(String(record.stack)).not.toContain("/Users/alice/");

    const listed = await logger.list(50);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ provider: "openrouter", status: 404 });

    const report = await logger.report({ "App version": "1.2.3", Platform: "test" });
    expect(report.count).toBe(1);
    expect(report.text).toContain("AI Coworker provider error report");
    expect(report.text).toContain("App version: 1.2.3");
    expect(report.text).not.toContain(secret);
    expect(report.text).not.toContain("/Users/alice/");
  });
});
