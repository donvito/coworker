import type { ThinkingLevelMap } from "@earendil-works/pi-ai";

export interface ReasoningCapableModel {
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
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
 */
export function withOpenRouterReasoningCompat<M extends ReasoningCapableModel>(model: M): M {
  if (!model.reasoning || model.thinkingLevelMap?.off === null) return model;
  return { ...model, thinkingLevelMap: { ...model.thinkingLevelMap, off: null } };
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
