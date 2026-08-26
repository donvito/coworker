import { describe, expect, it } from "vitest";
import { isDiscussionPass } from "@shared/discussion";

describe("discussion pass protocol", () => {
  it("accepts the pass marker with minor formatting differences", () => {
    expect(isDiscussionPass("PASS")).toBe(true);
    expect(isDiscussionPass("pass")).toBe(true);
    expect(isDiscussionPass("Pass.")).toBe(true);
    expect(isDiscussionPass("  PASS!  ")).toBe(true);
  });

  it("rejects substantive responses that merely include the word", () => {
    expect(isDiscussionPass("I'll pass this to Sarah.")).toBe(false);
    expect(isDiscussionPass("PASS, but one more thing: the budget.")).toBe(false);
    expect(isDiscussionPass("")).toBe(false);
    expect(isDiscussionPass(null)).toBe(false);
    expect(isDiscussionPass(undefined)).toBe(false);
  });
});
