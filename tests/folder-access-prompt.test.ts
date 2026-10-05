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
    expect(prompt).toContain("root: Downloads; read");
    expect(prompt).not.toContain("default output");
  });

  it("stays empty when no folder has been granted", () => {
    expect(formatGrantedFolders([])).toBe("");
  });
});
