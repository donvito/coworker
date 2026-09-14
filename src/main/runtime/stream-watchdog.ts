import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

export type ModelStreamFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

export interface IdleStreamWatchdogOptions {
  /** Abort the request when no stream event arrives for this long. */
  idleTimeoutMs: number;
}

/** Default: five minutes of silence. Long enough for slow reasoning, far below a hung route. */
export const defaultStreamIdleTimeoutMs = 5 * 60_000;

export function describeStreamStall(model: Pick<Model<Api>, "provider" | "id">, idleTimeoutMs: number): string {
  const seconds = Math.round(idleTimeoutMs / 1000);
  return `${model.provider}/${model.id} stopped sending data for ${seconds} seconds, so the request was cancelled. The provider route may be stalled; try again or choose another model.`;
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function errorMessageFrom(
  model: Model<Api>,
  partial: AssistantMessage | null,
  errorMessage: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: partial?.content ?? [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: partial?.usage ?? emptyUsage(),
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
  };
}

/**
 * Wrap a Pi stream function with an idle watchdog. Provider `timeoutMs` only
 * bounds the wait for response headers; once a body is streaming a stalled
 * route can sit silent indefinitely (a live OpenRouter run stalled for 24
 * minutes before the socket was torn down). The watchdog re-arms on every
 * stream event, aborts the provider request when the stream goes quiet for
 * `idleTimeoutMs`, and surfaces a clear `error` event instead of the
 * provider's generic "aborted" result. Aborts requested by the caller's own
 * signal pass through unchanged. Works for every provider because it only
 * observes the provider-neutral event stream.
 */
export function withIdleStreamWatchdog(
  streamFn: ModelStreamFn,
  options: IdleStreamWatchdogOptions,
): ModelStreamFn {
  if (!Number.isFinite(options.idleTimeoutMs) || options.idleTimeoutMs <= 0) {
    throw new Error("idleTimeoutMs must be a positive number of milliseconds");
  }
  return (model, context, streamOptions) => {
    const output = createAssistantMessageEventStream();
    void pump(streamFn, model, context, streamOptions, options.idleTimeoutMs, output);
    return output;
  };
}

async function pump(
  streamFn: ModelStreamFn,
  model: Model<Api>,
  context: Context,
  streamOptions: SimpleStreamOptions | undefined,
  idleTimeoutMs: number,
  output: AssistantMessageEventStream,
): Promise<void> {
  const controller = new AbortController();
  const callerSignal = streamOptions?.signal;
  const forwardAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) forwardAbort();
  else callerSignal?.addEventListener("abort", forwardAbort, { once: true });

  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      stalled = true;
      controller.abort(new Error(describeStreamStall(model, idleTimeoutMs)));
    }, idleTimeoutMs);
    timer.unref?.();
  };
  const stallMessage = () => describeStreamStall(model, idleTimeoutMs);

  let partial: AssistantMessage | null = null;
  try {
    arm();
    const inner = await streamFn(model, context, { ...streamOptions, signal: controller.signal });
    for await (const event of inner) {
      arm();
      if ("partial" in event) partial = event.partial;
      if (stalled && event.type === "error") {
        output.push({
          type: "error",
          reason: "error",
          error: { ...event.error, stopReason: "error", errorMessage: stallMessage() },
        });
        return;
      }
      output.push(event as AssistantMessageEvent);
      if (event.type === "done" || event.type === "error") return;
    }
    output.push({
      type: "error",
      reason: "error",
      error: errorMessageFrom(
        model,
        partial,
        stalled ? stallMessage() : "The model stream ended without a result.",
      ),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const reason = stalled || !callerSignal?.aborted ? "error" : "aborted";
    output.push({
      type: "error",
      reason,
      error: {
        ...errorMessageFrom(model, partial, stalled ? stallMessage() : detail),
        stopReason: reason,
      },
    });
  } finally {
    if (timer) clearTimeout(timer);
    callerSignal?.removeEventListener("abort", forwardAbort);
  }
}
