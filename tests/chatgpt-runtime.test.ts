import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAppService } from "@main/app/app-service";
import { MemoryCredentialStore } from "@main/security/credential-store";
import type { MainToWorkerMessage } from "@main/runtime/protocol";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function waitFor(predicate: () => boolean, description: string, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

async function within<T>(promise: Promise<T>, description: string, timeoutMs = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function makeAuthState(): string {
  const account = (id: string, accessToken: string) => ({
    id,
    clientId: `client-${id}`,
    subject: `subject-${id}`,
    label: id,
    email: `${id}@example.test`,
    accessToken,
    refreshToken: `refresh-${id}`,
    expiresAt: Date.now() + 3_600_000,
    scopes: ["chatgpt.tokens.use.direct", "resource.invoke"],
  });
  return JSON.stringify({
    schema: 1,
    hostId: "urn:uuid:1ecb05e4-6a13-4b93-bc0d-7b78b9d626e2",
    mode: "chatgpt-subscription",
    activeAccountId: "acct-one",
    welcomeSeen: true,
    accounts: [account("acct-one", "catalog-one"), account("acct-two", "catalog-two")],
  });
}

function catalogFetch() {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes(".well-known/openid-configuration")) {
      return new Response(JSON.stringify({
        issuer: "https://auth.openai.com",
        jwks_uri: "https://auth.openai.com/jwks",
        revocation_endpoint: "https://auth.openai.com/revoke",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/revoke")) return new Response("{}", { status: 200 });
    return new Response(JSON.stringify({
      models: [{ slug: "fixture-account-model", display_name: "Fixture model", visibility: "list" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind");
  return address.port;
}

async function collectJson(request: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function completedText(response: ServerResponse, text: string, suffix: string): void {
  const item = {
    id: `msg-${suffix}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  sendEvents(response, [
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_text.delta", output_index: 0, item_id: item.id, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: completedResponse(suffix, [item]) },
  ]);
}

function functionCall(response: ServerResponse, callId: string, name: string, argumentsText: string): void {
  const item = {
    id: `fc_${callId}`,
    type: "function_call",
    call_id: callId,
    name,
    namespace: "coworker",
    arguments: argumentsText,
  };
  sendEvents(response, [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: argumentsText },
    { type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: argumentsText },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: completedResponse(callId, [item]) },
  ]);
}

function completedResponse(id: string, output: unknown[]) {
  return {
    id: `resp-${id}`,
    object: "response",
    created_at: 1,
    status: "completed",
    output,
    usage: {
      input_tokens: 12,
      output_tokens: 4,
      total_tokens: 16,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

function sendEvents(response: ServerResponse, events: unknown[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n");
}

async function createFixtureService(
  root: string,
  responsePort: number,
  outboundMessages: MainToWorkerMessage[] = [],
) {
  const credentials = new MemoryCredentialStore();
  await credentials.set("model:openai:chatgpt", makeAuthState());
  const service = new DesktopAppService({
    dataPath: root,
    credentials,
    chatgpt: { fetchImpl: catalogFetch() as unknown as typeof fetch, openExternal: async () => undefined },
    workerFactory: () => {
      const worker = new Worker(resolve("out/main/runtime/coworker-worker.js"), {
        execArgv: ["--import", join(root, "redirect-fetch.mjs")],
        env: { ...process.env, COWORKER_FIXTURE_RESPONSES_URL: `http://127.0.0.1:${responsePort}/v1` },
      });
      const postMessage = worker.postMessage.bind(worker);
      (worker as unknown as { postMessage(message: MainToWorkerMessage): void }).postMessage = (message) => {
        outboundMessages.push(message);
        postMessage(message);
      };
      return worker;
    },
  });
  await writeFile(join(root, "redirect-fetch.mjs"), [
    "const originalFetch = globalThis.fetch.bind(globalThis);",
    "const fixture = process.env.COWORKER_FIXTURE_RESPONSES_URL;",
    "globalThis.fetch = (input, init) => {",
    "  const source = input instanceof Request ? input.url : String(input);",
    "  const url = new URL(source);",
    "  if (url.origin === 'https://api.openai.com') {",
    "    const target = new URL(url.pathname.replace(/^\\/v1/, '') + url.search, fixture);",
    "    return originalFetch(target, init);",
    "  }",
    "  return originalFetch(input, init);",
    "};",
  ].join("\n"));
  return service;
}

describe("ChatGPT subscription runtime", () => {
  it("runs Pi's Responses tool approval flow with fresh tokens and request-local namespace history", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-chatgpt-worker-approval-"));
    temporaryPaths.push(root);
    const requests: Array<{ body: Record<string, unknown>; token: string | null }> = [];
    let responseIndex = 0;
    const server = createServer(async (request, response) => {
      const body = await collectJson(request);
      requests.push({ body, token: request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? null });
      responseIndex += 1;
      if (responseIndex === 1) {
        functionCall(response, "approval-call-42", "files_write", JSON.stringify({
          path: "approved-once.txt",
          content: "approved exactly once",
        }));
      } else {
        completedText(response, "The file is ready.", `approval-final-${responseIndex}`);
      }
    });
    const port = await listen(server);
    const service = await createFixtureService(root, port);
    const issuedTokens: string[] = [];
    vi.spyOn(service.chatgptAuth, "getAccessToken").mockImplementation(async (expectedAccountId) => {
      expect(expectedAccountId).toBe("acct-one");
      const token = `opaque-inference-token-${issuedTokens.length + 1}`;
      issuedTokens.push(token);
      return token;
    });
    const executeApproval = vi.spyOn(service.tools, "executeApproval");

    try {
      await service.initialize();
      const coworker = await service.createCoworker({
        name: "Responses fixture",
        role: "Test operator",
        systemPrompt: "Use the requested local tool and finish.",
        modelProvider: "openai",
        modelName: "fixture-account-model",
        enabledTools: ["files.write"],
        policies: { "files.write": "approval" },
      });
      const task = service.createTask({
        coworkerId: coworker.id,
        title: "Prepare approved file",
        input: "Write the requested file and tell me when it is ready.",
        source: "manual",
      });
      await waitFor(() => service.database.getTask(task.id).status === "WAITING_FOR_APPROVAL", "file approval");
      const approval = service.database.getApprovalForTask(task.id);
      expect(approval?.status).toBe("PENDING");
      await service.decideApproval({ approvalId: approval!.id, decision: "approve" });
      await waitFor(() => ["COMPLETED", "FAILED"].includes(service.database.getTask(task.id).status), "approval continuation");

      expect(service.database.getTask(task.id).status).toBe("COMPLETED");
      expect(executeApproval).toHaveBeenCalledTimes(1);
      expect(await readFile(join(coworker.workspacePath, "approved-once.txt"), "utf8")).toBe("approved exactly once");
      expect(requests).toHaveLength(2);
      expect(issuedTokens.length).toBeGreaterThanOrEqual(requests.length);
      expect(requests.every(({ token }) => token !== null && issuedTokens.includes(token))).toBe(true);
      expect(new Set(requests.map(({ token }) => token)).size).toBe(requests.length);

      const firstBody = requests[0]!.body;
      expect(firstBody).toMatchObject({ model: "fixture-account-model", store: false, stream: true });
      const firstTools = firstBody.tools as Array<Record<string, unknown>>;
      expect(firstTools[0]).toMatchObject({ type: "namespace", name: "coworker" });
      expect((firstTools[0]!.tools as Array<Record<string, unknown>>).some((tool) => tool.name === "files_write")).toBe(true);

      const continuationInput = requests[1]!.body.input as Array<Record<string, unknown>>;
      const call = continuationInput.find((item) => item.type === "function_call");
      expect(call).toMatchObject({
        call_id: "approval-call-42",
        name: "files_write",
        namespace: "coworker",
        arguments: JSON.stringify({ path: "approved-once.txt", content: "approved exactly once" }),
      });
      expect(continuationInput.some((item) => item.type === "function_call_output" && item.call_id === "approval-call-42")).toBe(true);
      for (const { body } of requests) {
        expect(body).toMatchObject({ store: false, stream: true });
        expect(Array.isArray(body.input)).toBe(true);
        for (const field of ["previous_response_id", "background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "multi_agent", "prompt", "prompt_cache_retention", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user"]) {
          expect(body).not.toHaveProperty(field);
        }
      }
    } finally {
      await service.shutdown();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }, 30_000);

  it("requests a fresh account-bound token for each coworker and fences pending requests on account changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-chatgpt-worker-account-fence-"));
    temporaryPaths.push(root);
    const requests: Array<{ token: string | null; body: Record<string, unknown> }> = [];
    const server = createServer(async (request, response) => {
      const body = await collectJson(request);
      requests.push({ body, token: request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? null });
      completedText(response, "A fresh request finished.", `multi-${requests.length}`);
    });
    const port = await listen(server);
    const service = await createFixtureService(root, port);
    const tokenCalls: string[] = [];
    vi.spyOn(service.chatgptAuth, "getAccessToken").mockImplementation(async (expectedAccountId) => {
      tokenCalls.push(expectedAccountId ?? "missing-account");
      return `shared-service-token-${tokenCalls.length}`;
    });

    try {
      await service.initialize();
      const create = (name: string) => service.createCoworker({
        name,
        role: "Test operator",
        systemPrompt: "Reply briefly.",
        modelProvider: "openai",
        modelName: "fixture-account-model",
        enabledTools: [],
      });
      const [one, two] = await Promise.all([create("First coworker"), create("Second coworker")]);
      const first = service.createTask({ coworkerId: one.id, title: "First request", input: "Finish request one", source: "manual" });
      const second = service.createTask({ coworkerId: two.id, title: "Second request", input: "Finish request two", source: "manual" });
      await waitFor(() => service.database.getTask(first.id).status === "COMPLETED" && service.database.getTask(second.id).status === "COMPLETED", "both coworkers");
      expect(requests).toHaveLength(2);
      expect(tokenCalls.length).toBeGreaterThanOrEqual(requests.length);
      expect(tokenCalls.every((id) => id === "acct-one")).toBe(true);
      expect(new Set(requests.map(({ token }) => token)).size).toBe(2);
      expect(requests.every(({ token }) => token?.startsWith("shared-service-token-"))).toBe(true);
    } finally {
      await service.shutdown();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }, 30_000);

  it("retries startup after account switch and cancels per-run token requests on disconnect", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-chatgpt-worker-token-cancel-"));
    temporaryPaths.push(root);
    const outboundMessages: MainToWorkerMessage[] = [];
    const requests: Array<{ token: string | null; body: Record<string, unknown> }> = [];
    const server = createServer(async (request, response) => {
      const body = await collectJson(request);
      requests.push({ body, token: request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? null });
      completedText(response, "The account-bound request finished.", `account-fence-${requests.length}`);
    });
    const port = await listen(server);
    const service = await createFixtureService(root, port, outboundMessages);
    const firstAccountCatalogToken = deferred<string>();
    const disconnectToken = deferred<string>();
    const accountCalls: string[] = [];
    let holdNextAccountTwo = false;
    const accountCallCounts = new Map<string, number>();
    vi.spyOn(service.chatgptAuth, "getAccessToken").mockImplementation(async (expectedAccountId) => {
      const accountId = expectedAccountId ?? "missing-account";
      accountCalls.push(accountId);
      const callNumber = (accountCallCounts.get(accountId) ?? 0) + 1;
      accountCallCounts.set(accountId, callNumber);
      if (accountId === "acct-one" && callNumber === 1) return firstAccountCatalogToken.promise;
      if (accountId === "acct-two" && holdNextAccountTwo && callNumber === 3) return disconnectToken.promise;
      return callNumber === 1 ? `catalog-${accountId}` : `fresh-${accountId}-${callNumber}`;
    });

    try {
      await service.initialize();
      const coworker = await service.createCoworker({
        name: "Account-bound fixture",
        role: "Test operator",
        systemPrompt: "Reply briefly.",
        modelProvider: "openai",
        modelName: "fixture-account-model",
        enabledTools: [],
      });
      const first = service.createTask({ coworkerId: coworker.id, title: "Wait on first account", input: "Use the selected account", source: "manual" });
      await waitFor(() => accountCalls.includes("acct-one"), "first account token request");
      expect(service.database.getTask(first.id).status).toBe("RUNNING");

      await within(service.chatgptAuth.selectAccount("acct-two"), "account switch completion");
      await waitFor(
        () => ["COMPLETED", "FAILED"].includes(service.database.getTask(first.id).status),
        "replacement-account retry",
      );
      expect(service.database.getTask(first.id).status, JSON.stringify({ accountCalls, requests: requests.length, auth: await service.chatgptAuth.status() })).toBe("COMPLETED");
      firstAccountCatalogToken.resolve("stale-account-one-catalog-bearer");
      await new Promise((done) => setTimeout(done, 50));

      const tokenResponses = () => outboundMessages.filter(
        (message): message is Extract<MainToWorkerMessage, { type: "auth.token.response" }> =>
          message.type === "auth.token.response" && message.result.kind === "token",
      );
      expect(accountCalls).toContain("acct-two");
      expect(tokenResponses().every(({ result }) => result.kind === "token" && result.accessToken !== "stale-account-one-catalog-bearer")).toBe(true);
      expect(requests.every(({ token }) => token?.startsWith("fresh-acct-two-") === true)).toBe(true);

      holdNextAccountTwo = true;
      const second = service.createTask({ coworkerId: coworker.id, title: "Wait on disconnect", input: "Wait for sign out", source: "manual" });
      await waitFor(() => accountCalls.filter((id) => id === "acct-two").length === 3, "disconnect token request");
      await within(service.chatgptAuth.disconnect(), "disconnect completion");
      disconnectToken.resolve("stale-disconnected-bearer");
      await new Promise((done) => setTimeout(done, 50));
      expect((await service.chatgptAuth.status()).activeAccountId).toBeNull();
      expect(tokenResponses().some(({ result }) => result.kind === "token" && result.accessToken === "stale-disconnected-bearer")).toBe(false);
      expect(requests.every(({ token }) => token !== "stale-disconnected-bearer")).toBe(true);
      expect(["QUEUED", "FAILED", "CANCELLED"].includes(service.database.getTask(second.id).status)).toBe(true);
    } finally {
      firstAccountCatalogToken.resolve("cleanup-account-token");
      disconnectToken.resolve("cleanup-disconnect-token");
      await within(service.shutdown(), "token cancellation fixture shutdown", 8_000).catch(() => undefined);
      await new Promise<void>((done) => server.close(() => done()));
    }
  }, 30_000);

  it("does not leak opaque subscription tokens in quota failures and account-wide gates survive restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "coworker-chatgpt-worker-quota-"));
    temporaryPaths.push(root);
    const requests: Array<{ token: string | null; body: Record<string, unknown> }> = [];
    let firstRequest = true;
    const manualRequestReceived = deferred<ServerResponse>();
    const server = createServer(async (request, response) => {
      const body = await collectJson(request);
      const token = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? null;
      requests.push({ body, token });
      if (firstRequest) {
        firstRequest = false;
        response.writeHead(429, { "content-type": "application/json" });
        response.end(JSON.stringify({
          error: {
            message: `Subscription usage limit reached; opaque=${token}`,
            type: "invalid_request_error",
            code: "subscription_sharing_usage_limit_exceeded",
          },
        }));
      } else if (requests.length === 2) {
        manualRequestReceived.resolve(response);
      } else {
        completedText(response, "The manual request succeeded.", `quota-retry-${requests.length}`);
      }
    });
    const port = await listen(server);
    const service = await createFixtureService(root, port);
    let accessIndex = 0;
    vi.spyOn(service.chatgptAuth, "getAccessToken").mockImplementation(async () => `quota-fixture-token-${++accessIndex}`);

    let quotaTaskId = "";
    let originalServiceShutdown = false;
    try {
      await service.initialize();
      const coworker = await service.createCoworker({
        name: "Quota coworker",
        role: "Test operator",
        systemPrompt: "Reply briefly.",
        modelProvider: "openai",
        modelName: "fixture-account-model",
        enabledTools: [],
      });
      const other = await service.createCoworker({
        name: "Shared account coworker",
        role: "Test operator",
        systemPrompt: "Reply briefly.",
        modelProvider: "openai",
        modelName: "fixture-account-model",
        enabledTools: [],
      });
      const quotaTask = service.createTask({ coworkerId: coworker.id, title: "Observe quota", input: "Check the quota", source: "manual" });
      quotaTaskId = quotaTask.id;
      await waitFor(() => service.database.getTask(quotaTask.id).status === "FAILED", "quota failure");
      const failure = service.database.getTask(quotaTask.id).error ?? "";
      const secret = requests[0]?.token ?? "missing-token";
      expect(failure).toContain("subscription_sharing_usage_limit_exceeded");
      expect(failure).not.toContain(secret);
      expect(requests).toHaveLength(1);

      const oldSchedule = service.database.createTask({
        coworkerId: other.id,
        title: "Previously queued automation",
        input: "Run only after manual recovery",
        source: "schedule",
      });
      service.runtime.enqueueTask(other.id);
      await new Promise((done) => setTimeout(done, 100));
      expect(service.database.getTask(oldSchedule.id).status).toBe("QUEUED");
      expect(requests).toHaveLength(1);
      await service.providerErrors.flush();
      const report = await service.providerErrors.report({ version: "test" });
      expect(report.text).not.toContain(secret);

      // A new manager must recover the account pause from durable task history.
      await service.shutdown();
      originalServiceShutdown = true;
      const restarted = await createFixtureService(root, port);
      vi.spyOn(restarted.chatgptAuth, "getAccessToken").mockImplementation(async () => `restart-token-${++accessIndex}`);
      try {
        await restarted.initialize();
        await new Promise((done) => setTimeout(done, 150));
        expect(restarted.database.getTask(oldSchedule.id).status).toBe("QUEUED");
        expect(requests).toHaveLength(1);

        const manualRetry = restarted.createTask({
          coworkerId: other.id,
          title: "Selected manual recovery",
          input: "Try the request again now",
          source: "manual",
        });
        const pendingManualResponse = await manualRequestReceived.promise;
        expect(restarted.database.getTask(manualRetry.id).status).toBe("RUNNING");
        expect(restarted.database.getTask(oldSchedule.id).status).toBe("QUEUED");
        expect(JSON.stringify(requests[1]?.body.input)).toContain("Try the request again now");
        completedText(pendingManualResponse, "The manual request succeeded.", "manual-recovery");
        await waitFor(() => restarted.database.getTask(manualRetry.id).status === "COMPLETED", "manual recovery task");
        await waitFor(() => restarted.database.getTask(oldSchedule.id).status === "COMPLETED", "queued automation after manual success");
        expect(requests).toHaveLength(3);
        expect(JSON.stringify(requests[2]?.body.input)).toContain("Run only after manual recovery");
        expect(restarted.database.getTask(quotaTaskId).error).toContain("subscription_sharing_usage_limit_exceeded");
      } finally {
        await restarted.shutdown();
      }
    } finally {
      if (!originalServiceShutdown) {
        await service.shutdown().catch(() => undefined);
      }
      await new Promise<void>((done) => server.close(() => done()));
    }
  }, 45_000);
});
