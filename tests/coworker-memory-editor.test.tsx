// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoworkerMemoryEditor } from "@renderer/components/CoworkerMemoryEditor";

afterEach(() => cleanup());
function fixture() {
  const document = { path: "MEMORY.md", content: "- Use SGD.", revision: "a".repeat(64) };
  const read = vi.fn().mockResolvedValue(document);
  const update = vi.fn().mockImplementation(async (_id, { content }) => ({ ...document, content, revision: "b".repeat(64) }));
  Object.defineProperty(window, "coworker", { configurable: true, value: { memory: { read, update } } });
  render(<CoworkerMemoryEditor coworkerId="ava" name="Ava" />);
  return { read, update, document };
}

describe("desktop memory editor", () => {
  it("loads, edits, saves, and clears Markdown using the latest revision", async () => {
    const { read, update, document } = fixture();
    const editor = await screen.findByDisplayValue(document.content) as HTMLTextAreaElement;
    expect(read).toHaveBeenCalledWith("ava");
    fireEvent.change(editor, { target: { value: "- Use USD.\n- Be concise." } });
    fireEvent.click(screen.getByRole("button", { name: "Save memory" }));
    await screen.findByRole("status");
    expect(update).toHaveBeenCalledWith("ava", { content: "- Use USD.\n- Be concise.", expectedRevision: document.revision });
    fireEvent.change(editor, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save memory" }));
    await waitFor(() => expect(update).toHaveBeenLastCalledWith("ava", { content: "", expectedRevision: "b".repeat(64) }));
  });

  it("keeps an unsaved draft after a conflict and reloads the current file on request", async () => {
    const { read, update, document } = fixture();
    const editor = await screen.findByDisplayValue(document.content) as HTMLTextAreaElement;
    update.mockRejectedValueOnce(new Error("File changed since it was read."));
    fireEvent.change(editor, { target: { value: "My unsaved changes" } });
    fireEvent.click(screen.getByRole("button", { name: "Save memory" }));
    expect((await screen.findByRole("alert")).textContent).toContain("File changed");
    expect(editor.value).toBe("My unsaved changes");
    read.mockResolvedValueOnce({ ...document, content: "A coworker's recent edit", revision: "c".repeat(64) });
    fireEvent.click(screen.getByRole("button", { name: "Reload memory" }));
    await screen.findByDisplayValue("A coworker's recent edit");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(editor, { target: { value: "Merged changes" } });
    fireEvent.click(screen.getByRole("button", { name: "Save memory" }));
    await waitFor(() => expect(update).toHaveBeenLastCalledWith("ava", { content: "Merged changes", expectedRevision: "c".repeat(64) }));
  });

  it("disables saving when loading fails and supports retry", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("Could not load MEMORY.md"))
      .mockResolvedValue({ path: "MEMORY.md", content: "Recovered", revision: "0".repeat(64) });
    Object.defineProperty(window, "coworker", { configurable: true, value: { memory: { read } } });
    render(<CoworkerMemoryEditor coworkerId="ava" name="Ava" />);
    await screen.findByRole("alert");
    expect((screen.getByRole("button", { name: "Save memory" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reload memory" }));
    await screen.findByDisplayValue("Recovered");
  });

  it("prevents oversized saves and displays the budget", async () => {
    const { update, document } = fixture();
    const editor = await screen.findByDisplayValue(document.content) as HTMLTextAreaElement;
    expect(editor.maxLength).toBe(8000);
    fireEvent.change(editor, { target: { value: "x".repeat(8001) } });
    expect(screen.getByText("8,001 / 8,000 characters")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save memory" }) as HTMLButtonElement).disabled).toBe(true);
    expect(update).not.toHaveBeenCalled();
  });
});
