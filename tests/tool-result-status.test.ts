import { describe, expect, it } from "vitest";
import type { Message } from "@ag-ui/core";
import {
  findRecoveredToolCallIds,
  parseToolResultStatus,
} from "@shared/tool-result-status";

function user(id: string): Message {
  return { id, role: "user", content: "Create the file" };
}

function assistant(
  id: string,
  calls: Array<{ id: string; name: string; arguments: unknown }>,
): Message {
  return {
    id,
    role: "assistant",
    toolCalls: calls.map((call) => ({
      id: call.id,
      type: "function" as const,
      function: {
        name: call.name,
        arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments),
      },
    })),
  };
}

function tool(id: string, toolCallId: string, content: unknown): Message {
  return {
    id,
    role: "tool",
    toolCallId,
    content: typeof content === "string" ? content : JSON.stringify(content),
  };
}

const confirmsArtifact = (result: unknown): boolean =>
  typeof result === "string" && result.includes('"artifactId":"artifact-1"');

function exportRetryMessages(
  failedArguments: unknown,
  successArguments: unknown,
  successResult: unknown = { artifactId: "artifact-1" },
): Message[] {
  return [
    user("user-1"),
    assistant("assistant-1", [
      { id: "failed-call", name: "documents.export", arguments: failedArguments },
    ]),
    tool("result-1", "failed-call", { isError: true, error: "Missing name" }),
    assistant("assistant-2", [
      { id: "retry-call", name: "documents.export", arguments: successArguments },
    ]),
    tool("result-2", "retry-call", successResult),
  ];
}

describe("tool result status", () => {
  it("recognizes the structured error envelope", () => {
    expect(
      parseToolResultStatus(JSON.stringify({ isError: true, error: "Export failed." })),
    ).toEqual({ isError: true, error: "Export failed." });
  });

  it("leaves structured success results neutral", () => {
    expect(parseToolResultStatus(JSON.stringify({ isError: false, artifactId: "artifact-1" }))).toEqual({
      isError: false,
      error: null,
    });
  });

  it("does not classify malformed or unstructured text as an error", () => {
    expect(parseToolResultStatus("not valid JSON: tool failed")).toEqual({
      isError: false,
      error: null,
    });
  });

  it("recovers a failed export when a later same-turn retry adds only a missing name", () => {
    const messages = exportRetryMessages(
      { formats: ["pdf"], content: "exact content" },
      { name: "ai_news_summary", formats: ["pdf"], content: "exact content" },
    );

    expect(findRecoveredToolCallIds(messages, confirmsArtifact)).toEqual(new Set(["failed-call"]));
  });

  it.each([
    ["pending retry", undefined],
    ["failed retry", { isError: true, error: "Still failed" }],
  ])("does not recover a %s", (_label, retryResult) => {
    const messages = exportRetryMessages(
      { formats: ["pdf"], content: "exact content" },
      { name: "ai_news_summary", formats: ["pdf"], content: "exact content" },
      retryResult,
    );
    if (retryResult === undefined) messages.pop();

    expect(findRecoveredToolCallIds(messages, confirmsArtifact)).toEqual(new Set());
  });

  it.each([
    [
      "changed content",
      { formats: ["pdf"], content: "exact content" },
      { name: "ai_news_summary", formats: ["pdf"], content: "changed" },
    ],
    [
      "changed target",
      { name: "original_summary", formats: ["pdf"], content: "exact content" },
      { name: "other_summary", formats: ["pdf"], content: "exact content" },
    ],
    [
      "different tool",
      { formats: ["pdf"], content: "exact content" },
      { name: "ai_news_summary", formats: ["pdf"], content: "exact content" },
    ],
  ])("does not recover when the retry has %s", (label, failedArguments, successArguments) => {
    const messages = exportRetryMessages(
      failedArguments,
      successArguments,
    );
    if (label === "different tool") {
      messages[3] = assistant("assistant-2", [
        { id: "retry-call", name: "files.write", arguments: successArguments },
      ]);
    }

    expect(findRecoveredToolCallIds(messages, confirmsArtifact)).toEqual(new Set());
  });

  it("uses a later successful retry when an earlier retry also fails", () => {
    const messages: Message[] = [
      user("user-1"),
      assistant("assistant-1", [
        { id: "failed-call", name: "documents.export", arguments: { formats: ["pdf"] } },
      ]),
      tool("result-1", "failed-call", { isError: true, error: "Missing name" }),
      assistant("assistant-2", [
        { id: "retry-call-1", name: "documents.export", arguments: { formats: ["pdf"] } },
      ]),
      tool("result-2", "retry-call-1", { isError: true, error: "Still missing name" }),
      assistant("assistant-3", [
        {
          id: "retry-call-2",
          name: "documents.export",
          arguments: { name: "ai_news_summary", formats: ["pdf"] },
        },
      ]),
      tool("result-3", "retry-call-2", { artifactId: "artifact-1" }),
    ];

    expect(findRecoveredToolCallIds(messages, confirmsArtifact)).toEqual(
      new Set(["failed-call", "retry-call-1"]),
    );
  });

  it("requires arrays to match exactly", () => {
    const messages = exportRetryMessages(
      { formats: [{ format: "pdf" }] },
      { name: "ai_news_summary", formats: [{ format: "pdf", extra: true }] },
    );

    expect(findRecoveredToolCallIds(messages, confirmsArtifact)).toEqual(new Set());
  });

  it("does not recover across a new user turn", () => {
    const messages = exportRetryMessages(
      { formats: ["pdf"], content: "exact content" },
      { name: "ai_news_summary", formats: ["pdf"], content: "exact content" },
    );
    messages.splice(3, 0, user("user-2"));

    expect(findRecoveredToolCallIds(messages, confirmsArtifact)).toEqual(new Set());
  });

  it.each([
    ["malformed JSON", "{not json}"],
    ["empty object", {}],
    ["array", ["pdf"]],
  ])("does not recover with a malformed or non-object failed argument: %s", (_label, failedArguments) => {
    const messages = exportRetryMessages(
      failedArguments,
      { name: "ai_news_summary", formats: ["pdf"], content: "exact content" },
    );

    expect(findRecoveredToolCallIds(messages, confirmsArtifact)).toEqual(new Set());
  });
});
