import { describe, expect, it } from "vitest";
import { toProviderToolName } from "@main/runtime/tool-names";

describe("provider-compatible tool names", () => {
  it("normalizes controlled dotted names without losing word boundaries", () => {
    expect(toProviderToolName("files.list")).toBe("files_list");
    expect(toProviderToolName("email.create_draft")).toBe("email_create_draft");
  });

  it("preserves names already accepted by model providers", () => {
    expect(toProviderToolName("search-web_v2")).toBe("search-web_v2");
  });
});
