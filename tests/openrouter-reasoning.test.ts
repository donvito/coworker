import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { Type, type Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  clearEchoedReasoningField,
  withOpenRouterReasoningCompat,
  type ReasoningCapableModel,
} from "@main/runtime/openrouter-reasoning";

describe("OpenRouter reasoning compatibility", () => {
  it("marks the off level unsupported so Pi omits the reasoning parameter", () => {
    const input: ReasoningCapableModel = { reasoning: true };
    const model = withOpenRouterReasoningCompat(input);
    // Pi only skips `reasoning: { effort: "none" }` when off is exactly null.
    expect(model.thinkingLevelMap?.off).toBeNull();
  });

  it("preserves other thinking level mappings", () => {
    const model = withOpenRouterReasoningCompat({
      reasoning: true,
      thinkingLevelMap: { low: "low", high: "high" },
    });
    expect(model.thinkingLevelMap).toEqual({ low: "low", high: "high", off: null });
  });

  it("leaves non-reasoning and already-compatible models untouched", () => {
    const plain = { reasoning: false };
    expect(withOpenRouterReasoningCompat(plain)).toBe(plain);
    const compatible = { reasoning: true, thinkingLevelMap: { off: null } };
    expect(withOpenRouterReasoningCompat(compatible)).toBe(compatible);
  });

  it("fixes the catalog model that rejected requests with mandatory reasoning", () => {
    const model = openrouterProvider()
      .getModels()
      .find((candidate) => candidate.id === "google/gemini-3.7-flash");
    expect(model).toBeDefined();
    expect(model?.reasoning).toBe(true);
    // Without the compat fix Pi would send `reasoning: { effort: "none" }`.
    expect(model?.thinkingLevelMap?.off).not.toBeNull();
    expect(withOpenRouterReasoningCompat(model!).thinkingLevelMap?.off).toBeNull();
  });

  it("preserves compatibility options and keeps an already-enabled Gemini model on Vertex", () => {
    const model = withOpenRouterReasoningCompat({
      id: "google/gemini-3.7-flash", reasoning: true,
      thinkingLevelMap: { off: null },
      compat: { supportsDeveloperRole: false, openRouterRouting: { zdr: true } },
    });
    expect(model.compat).toEqual({
      supportsDeveloperRole: false,
      openRouterRouting: { zdr: true, only: ["google-vertex"], allow_fallbacks: false },
    });
    expect(withOpenRouterReasoningCompat({ id: "anthropic/claude-sonnet-4", reasoning: true })).not.toHaveProperty("compat");
    expect(withOpenRouterReasoningCompat({ id: "google/gemini-example", reasoning: false })).not.toHaveProperty("compat");
  });

  it("sends the same route and intact signature on a tool call and checkpoint resume", async () => {
    const provider = openrouterProvider();
    const model = withOpenRouterReasoningCompat(provider.getModels().find(m => m.id === "google/gemini-3.7-flash")!);
    const signature = { type: "reasoning.encrypted", id: "call-1", data: "opaque-test-signature", format: "google-gemini-v1", index: 0 };
    const requests: any[] = [];
    const fetch: typeof globalThis.fetch = async (_url, options) => {
      requests.push(JSON.parse(String(options?.body)));
      const first = requests.length === 1;
      const chunks = [
        { choices: [{ index: 0, delta: first ? {
          tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "propose", arguments: '{"text":"Example"}' } }],
          reasoning_details: [signature],
        } : { content: "Understood. Nothing saved." }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }] },
      ];
      return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    };
    const context: Context = {
      messages: [{ role: "user", content: "Remember this example", timestamp: Date.now() }],
      tools: [{ name: "propose", description: "Propose an edit", parameters: Type.Object({ text: Type.String() }) }],
    };
    const first = await provider.streamSimple(model, context, { apiKey: "test-key", fetch }).result();
    expect(first.stopReason).toBe("toolUse");
    context.messages.push(JSON.parse(JSON.stringify(first)), {
      role: "toolResult", toolCallId: "call-1", toolName: "propose", content: [{ type: "text", text: "Approval required. Task paused." }], isError: false, timestamp: Date.now(),
    }, { role: "user", content: "The human rejected the proposal. Continue.", timestamp: Date.now() });
    const resumed = await provider.streamSimple(model, context, { apiKey: "test-key", fetch }).result();
    expect(resumed.stopReason).toBe("stop");
    expect(requests).toHaveLength(2);
    for (const request of requests) expect(request.provider).toEqual({ only: ["google-vertex"], allow_fallbacks: false });
    expect(requests[1].messages.find((m: any) => m.role === "assistant").reasoning_details).toEqual([signature]);
  });
});

describe("restored checkpoint reasoning blocks", () => {
  it("clears a thinking signature that would overwrite reasoning_details", () => {
    const restored = clearEchoedReasoningField({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "step one", thinkingSignature: "reasoning_details" },
        { type: "toolCall", id: "call-1", name: "web_search", thoughtSignature: '{"a":1}' },
      ],
    });

    expect(restored.content[0]).toMatchObject({ thinkingSignature: "" });
    // The tool call's real thought signature must survive untouched.
    expect(restored.content[1]).toMatchObject({ thoughtSignature: '{"a":1}' });
  });

  it("leaves legitimate signatures and other messages alone", () => {
    const reasoningContent = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "x", thinkingSignature: "reasoning_content" }],
    };
    expect(clearEchoedReasoningField(reasoningContent)).toBe(reasoningContent);

    const plain = { role: "user", content: "hello" };
    expect(clearEchoedReasoningField(plain)).toBe(plain);
  });
});
