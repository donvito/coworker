import type { TranscriptContext } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  chatGPTSubscriptionTerminalFailure,
  chatGPTResponsesBaseUrl,
  createChatGPTSubscriptionModel,
  createChatGPTSubscriptionProvider,
  restrictChatGPTSubscriptionPayload,
} from "@main/runtime/chatgpt-subscription-provider";

const model = createChatGPTSubscriptionModel({
  modelId: "account-listed-model",
  supportsImages: true,
  contextWindow: 65_536,
});

function eventStream(event: unknown): Response {
  return new Response("data: " + JSON.stringify(event) + "\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function streamFixture(fetchImpl: typeof fetch) {
  const provider = createChatGPTSubscriptionProvider(model);
  const context = {
    messages: [{ role: "user", content: "Continue this task", timestamp: Date.now() }],
  } as TranscriptContext;
  const stream = provider.streamSimple(model, context, {
    apiKey: "one-request-access-token",
    fetch: fetchImpl,
    timeoutMs: 2_000,
    maxRetries: 0,
    onPayload: (payload) => restrictChatGPTSubscriptionPayload(payload),
    onProviderStreamEvent: (event) => {
      const failure = chatGPTSubscriptionTerminalFailure(event);
      if (failure) throw failure;
    },
  });
  const events = [];
  for await (const event of stream) events.push(event);
  return { result: await stream.result(), events };
}

describe("Pi ChatGPT subscription Responses adapter", () => {
  it("uses the public OpenAI Responses route with a restricted stateless request", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(input);
      requestInit = init;
      return eventStream({
        type: "response.completed",
        response: {
          id: "resp-complete",
          object: "response",
          created_at: 1,
          status: "completed",
          model: model.id,
          output: [],
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      });
    });

    const { result } = await streamFixture(fetchImpl as unknown as typeof fetch);
    const body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
    expect(requestUrl).toBe(chatGPTResponsesBaseUrl + "/responses");
    expect(new Headers(requestInit?.headers).get("authorization")).toBe(
      "Bearer one-request-access-token",
    );
    expect(body).toMatchObject({ model: model.id, store: false, stream: true });
    expect(Array.isArray(body.input)).toBe(true);
    for (const field of [
      "previous_response_id", "background", "conversation", "max_output_tokens",
      "max_tool_calls", "metadata", "moderation", "multi_agent", "prompt",
      "prompt_cache_options", "prompt_cache_retention", "safety_identifier",
      "temperature", "top_logprobs", "top_p", "truncation", "user",
    ]) {
      expect(body).not.toHaveProperty(field);
    }
    expect(result.stopReason).toBe("stop");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("groups controlled functions and adds coworker namespace to API-key-era history only at request time", () => {
    const originalInput = [
      { type: "function_call", call_id: "call_keep", name: "files_write", arguments: "{\"path\":\"a\"}" },
      { type: "function_call_output", call_id: "call_keep", output: "done" },
    ];
    const payload = {
      model: model.id,
      store: true,
      stream: false,
      input: originalInput,
      tools: [
        { type: "function", name: "files_write", parameters: { type: "object" }, strict: false },
        { type: "file_search" },
      ],
      additional_tools: [{ type: "tool_search" }],
      previous_response_id: "old-response",
      max_output_tokens: 800,
    };

    const restricted = restrictChatGPTSubscriptionPayload(payload);
    expect(restricted).toMatchObject({ store: false, stream: true });
    expect(restricted.input).toEqual([
      {
        type: "function_call",
        call_id: "call_keep",
        name: "files_write",
        arguments: "{\"path\":\"a\"}",
        namespace: "coworker",
      },
      { type: "function_call_output", call_id: "call_keep", output: "done" },
    ]);
    expect(restricted.tools).toEqual([
      {
        type: "namespace",
        name: "coworker",
        description: expect.any(String),
        tools: [{ type: "function", name: "files_write", parameters: { type: "object" }, strict: false }],
      },
    ]);
    expect(restricted).not.toHaveProperty("additional_tools");
    expect(restricted).not.toHaveProperty("previous_response_id");
    expect(restricted).not.toHaveProperty("max_output_tokens");
    expect(payload.input).toEqual(originalInput);
  });

  it("fails incomplete, failed, interrupted, and quota responses without retrying quota", async () => {
    const incomplete = await streamFixture(
      vi.fn(async () =>
        eventStream({
          type: "response.incomplete",
          response: {
            id: "resp-incomplete",
            object: "response",
            created_at: 1,
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            output: [],
          },
        }),
      ) as unknown as typeof fetch,
    );
    expect(incomplete.result.stopReason).toBe("error");
    expect(incomplete.result.errorMessage).toContain("max_output_tokens");

    const failed = await streamFixture(
      vi.fn(async () =>
        eventStream({
          type: "response.failed",
          response: {
            id: "resp-failed",
            object: "response",
            created_at: 1,
            status: "failed",
            error: { code: "invalid_request_error", message: "Model rejected request" },
          },
        }),
      ) as unknown as typeof fetch,
    );
    expect(failed.result.stopReason).toBe("error");
    expect(failed.result.errorMessage).toContain("invalid_request_error");

    const interrupted = await streamFixture(
      vi.fn(async () =>
        new Response("data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp-open\"}}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ) as unknown as typeof fetch,
    );
    expect(interrupted.result.stopReason).toBe("error");
    expect(interrupted.result.errorMessage).toContain("before a terminal response event");

    const quotaFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "Usage is unavailable",
            type: "invalid_request_error",
            code: "subscription_sharing_usage_limit_exceeded",
          },
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      ),
    );
    const quota = await streamFixture(quotaFetch as unknown as typeof fetch);
    expect(quota.result.stopReason).toBe("error");
    expect(quota.result.errorMessage).toContain("subscription_sharing_usage_limit_exceeded");
    expect(quotaFetch).toHaveBeenCalledTimes(1);
  });
});
