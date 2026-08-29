import { describe, expect, it } from "vitest";
import { formatGrantedFolders } from "@shared/folder-access-prompt";

describe("granted folder prompt", () => {
  it("names every granted folder so file questions include them", () => {
    const prompt = formatGrantedFolders([
      { alias: "Downloads", path: "/Users/mel/Downloads" },
      { alias: "Notes", path: "/Users/mel/Library/Notes" },
    ]);

    expect(prompt).toContain("- Downloads — /Users/mel/Downloads");
    expect(prompt).toContain("- Notes — /Users/mel/Library/Notes");
    expect(prompt).toContain("rather than answering only from your coworker workspace");
    expect(prompt).toContain("folders.list");
    expect(prompt).toContain("folders.read");
    expect(prompt).toContain("never create, change, or delete");
  });

  it("stays empty when no folder has been granted", () => {
    expect(formatGrantedFolders([])).toBe("");
  });
});
