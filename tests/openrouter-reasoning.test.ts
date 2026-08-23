import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
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
