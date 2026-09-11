import type { OpenAICompletionsCompat, ThinkingLevelMap } from "@earendil-works/pi-ai";

export interface ReasoningCapableModel {
  id?: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  compat?: object;
}

/**
 * Pi's OpenRouter mapping sends `reasoning: { effort: "none" }` whenever no
 * reasoning effort was requested, unless the model maps the "off" level to
 * null. Routes where reasoning is mandatory (for example Gemini Flash
 * thinking endpoints) reject that request with HTTP 400 "Reasoning is
 * mandatory for this endpoint and cannot be disabled."
 *
 * This app never asks to disable reasoning, so mark "off" as unsupported on
 * every OpenRouter reasoning model. Pi then omits the reasoning parameter
 * entirely and the route's own default applies.
 *
 * Gemini tool signatures also cannot be replayed across Google's Vertex and
 * AI Studio routes: a live reproduction returned 400 for the unchanged
 * signature on AI Studio and succeeded with the same history on Vertex.
 * Keep all requests on Vertex, including the first request and approval
 * resumes. Ordinary transient failures still use the bounded provider retry.
 */
export function withOpenRouterReasoningCompat<M extends ReasoningCapableModel>(model: M): M {
  if (!model.reasoning) return model;
  const compatible = model.thinkingLevelMap?.off === null
    ? model
    : { ...model, thinkingLevelMap: { ...model.thinkingLevelMap, off: null } };
  if (!model.id?.startsWith("google/gemini-")) return compatible;
  const compat = model.compat as OpenAICompletionsCompat | undefined;
  return {
    ...compatible,
    compat: {
      ...compat,
      openRouterRouting: {
        ...compat?.openRouterRouting,
        only: ["google-vertex"],
        allow_fallbacks: false,
      },
    },
  };
}

/**
 * A thinking block's `thinkingSignature` names the request field its text is
 * echoed back in. Checkpoints written before that was understood name
 * `reasoning_details`, which is where Gemini's encrypted thought signatures
 * travel, so replaying one overwrites a signature with plain text and the
 * request is rejected for a corrupted thought signature. Clear the name when
 * restoring; the reasoning text is display-only and needs no echo field.
 */
export function clearEchoedReasoningField<M>(message: M): M {
  const blocks = (message as { content?: unknown })?.content;
  if (!Array.isArray(blocks)) return message;
  let changed = false;
  const content = blocks.map((block) => {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "thinking" &&
      (block as { thinkingSignature?: unknown }).thinkingSignature === "reasoning_details"
    ) {
      changed = true;
      return { ...block, thinkingSignature: "" };
    }
    return block;
  });
  return changed ? { ...message, content } : message;
}
