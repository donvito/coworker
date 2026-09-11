import type { Message } from "@ag-ui/core";

export interface ToolResultStatus {
  isError: boolean;
  error: string | null;
}

export type ToolResultSuccessPredicate = (result: unknown) => boolean;

/**
 * Reads the structured error envelope emitted for failed tool executions.
 * Historical tool results can contain arbitrary plain text, so those remain
 * neutral instead of being classified from error-like wording.
 */
export function parseToolResultStatus(result: unknown): ToolResultStatus {
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return { isError: false, error: null };
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { isError: false, error: null };
  }
  const record = value as Record<string, unknown>;
  if (record.isError !== true) return { isError: false, error: null };
  const error =
    typeof record.error === "string" && record.error.trim().length > 0
      ? record.error
      : "The tool reported an error.";
  return { isError: true, error };
}

interface ToolCallRecord {
  id: string;
  name: string;
  arguments: unknown;
  order: number;
  turn: number;
}

interface ToolResultRecord {
  toolCallId: string;
  content: string;
  error?: string;
  order: number;
  turn: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function matchesSubset(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((value, index) => matchesExactly(value, actual[index]))
    );
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) return false;
    return Object.entries(expected).every(
      ([key, value]) =>
        Object.prototype.hasOwnProperty.call(actual, key) && matchesSubset(value, actual[key]),
    );
  }
  return Object.is(expected, actual);
}

function matchesExactly(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((value, index) => matchesExactly(value, actual[index]))
    );
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) return false;
    const expectedKeys = Object.keys(expected);
    const actualKeys = Object.keys(actual);
    return (
      expectedKeys.length === actualKeys.length &&
      expectedKeys.every(
        (key) =>
          Object.prototype.hasOwnProperty.call(actual, key) &&
          matchesExactly(expected[key], actual[key]),
      )
    );
  }
  return Object.is(expected, actual);
}

function isNonEmptyObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length > 0;
}

/**
 * Finds failed tool-call IDs whose same-turn retry later completed with a
 * confirmed successful result. Recovery is intentionally conservative: the
 * failed arguments must be a non-empty recursive subset of the retry's
 * arguments, and arrays must match exactly.
 */
export function findRecoveredToolCallIds(
  messages: readonly Message[],
  isSuccessfulResult: ToolResultSuccessPredicate,
): Set<string> {
  const calls: ToolCallRecord[] = [];
  const results: ToolResultRecord[] = [];
  let turn = -1;
  let order = 0;

  for (const message of messages) {
    if (message.role === "user") {
      turn += 1;
      order += 1;
      continue;
    }
    if (message.role === "assistant") {
      for (const [callIndex, toolCall] of (message.toolCalls ?? []).entries()) {
        if (!toolCall.id || !toolCall.function.name) continue;
        calls.push({
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: parseToolArguments(toolCall.function.arguments),
          order: order + callIndex,
          turn,
        });
      }
      order += Math.max(1, message.toolCalls?.length ?? 0);
      continue;
    }
    if (message.role === "tool") {
      results.push({
        toolCallId: message.toolCallId,
        content: message.content,
        error: message.error,
        order,
        turn,
      });
      order += 1;
      continue;
    }
    order += 1;
  }

  const recovered = new Set<string>();
  for (const failedCall of calls) {
    if (!isNonEmptyObject(failedCall.arguments) || failedCall.turn < 0) continue;
    const failedResult = results.find(
      (result) =>
        result.toolCallId === failedCall.id &&
        result.turn === failedCall.turn &&
        result.order > failedCall.order &&
        parseToolResultStatus(result.content).isError,
    );
    if (!failedResult) continue;

    const recoveredByRetry = calls.some(
      (candidate) =>
        candidate.name === failedCall.name &&
        candidate.turn === failedCall.turn &&
        candidate.order > failedResult.order &&
        isNonEmptyObject(candidate.arguments) &&
        matchesSubset(failedCall.arguments, candidate.arguments) &&
        results.some((result) => {
          if (
            result.toolCallId !== candidate.id ||
            result.turn !== candidate.turn ||
            result.order <= candidate.order ||
            result.error
          ) {
            return false;
          }
          const status = parseToolResultStatus(result.content);
          if (status.isError) return false;
          try {
            return isSuccessfulResult(result.content);
          } catch {
            return false;
          }
        }),
    );
    if (recoveredByRetry) recovered.add(failedCall.id);
  }
  return recovered;
}
