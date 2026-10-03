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
    expect(report.text).toContain("Coworker provider error report");
    expect(report.text).toContain("App version: 1.2.3");
    expect(report.text).not.toContain(secret);
    expect(report.text).not.toContain("/Users/alice/");
  });

  it("redacts OAuth material and full authorization URLs from diagnostics and support reports", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-oauth-provider-log-"));
    temporaryPaths.push(root);
    const path = join(root, "logs", "provider-errors.jsonl");
    const logger = new ProviderErrorLogger(path);
    const secrets = [
      "access-secret-value-101",
      "refresh-secret-value-202",
      "identity-secret-value-303",
      "hint-secret-value-404",
      "authorization-code-505",
      "verifier-secret-value-606",
      "eyJhbGciOiJub25lMTIz.eyJzdWIiOiJwcml2YXRlMTIz.signaturevalue123",
    ];
    const diagnostic =
      "429 API failure at https://auth.openai.com/oauth/authorize?code=authorization-code-505&state=state-secret " +
      "access_token=" + secrets[0] + " refresh_token=" + secrets[1] + " id_token=" + secrets[2] +
      " id_token_hint=" + secrets[3] + " code=" + secrets[4] + " code_verifier=" + secrets[5] +
      " bearer=" + secrets[6] + ". Keep this useful: stream interrupted after response.created.";

    await logger.log(
      {
        phase: "inference",
        provider: "openai",
        model: "account-model",
      },
      new Error(diagnostic),
    );

    const contents = await readFile(path, "utf8");
    const report = await logger.report({ "App version": "1.2.3" });
    for (const secret of secrets) {
      expect(contents).not.toContain(secret);
      expect(report.text).not.toContain(secret);
    }
    expect(contents).not.toContain("https://auth.openai.com/oauth/authorize");
    expect(report.text).not.toContain("https://auth.openai.com/oauth/authorize");
    expect(contents).toContain("429 API failure");
    expect(report.text).toContain("stream interrupted after response.created.");
  });
});
