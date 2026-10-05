// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComposerTools } from "@renderer/components/ComposerTools";
import type { Coworker } from "@shared/contracts";

afterEach(cleanup);

const sharedFolders = [
  { path: "/tmp/output", alias: "Output", access: "read-write" as const, defaultOutput: true },
  { path: "/tmp/input", alias: "Input", access: "read" as const },
];

function setup() {
  const update = vi.fn().mockResolvedValue(undefined);
  const pick = vi.fn().mockResolvedValue(["/tmp/new"]);
  Object.defineProperty(window, "coworker", { configurable: true, value: {
    coworkers: { update }, folders: { pick },
  } });
  const coworker = { id: "ava", name: "Ava", sharedFolders, enabledSkillIds: [] } as unknown as Coworker;
  render(<ComposerTools coworker={coworker} skills={[]} onChanged={vi.fn().mockResolvedValue(undefined)} />);
  fireEvent.click(screen.getByRole("button", { name: "2 folders" }));
  return { update, pick };
}

it("asks for access after picking, then saves writing and the selected output destination", async () => {
  const { update } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Add folder…" }));
  const access = await screen.findByRole("radiogroup", { name: "Access for selected folders" }).then(group => within(group).getByRole("radio", { name: "Read-only" }));
  expect(update).not.toHaveBeenCalled();
  expect((access as HTMLInputElement).checked).toBe(true);
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Access for selected folders" })).getByRole("radio", { name: "Read and write" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Default output folder" }));
  fireEvent.click(screen.getByRole("button", { name: "Grant access" }));
  await waitFor(() => expect(update).toHaveBeenCalledWith("ava", { sharedFolderGrants: [
    { path: "/tmp/output", access: "read-write", defaultOutput: false },
    { path: "/tmp/input", access: "read", defaultOutput: false },
    { path: "/tmp/new", access: "read-write", defaultOutput: true },
  ] }));
  await waitFor(() => expect(screen.queryByRole("radiogroup", { name: "Access for selected folders" })).toBeNull());
});

it("keeps existing write access and output selection when removing another folder", async () => {
  const { update } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Remove folder /tmp/input" }));
  await waitFor(() => expect(update).toHaveBeenCalledWith("ava", { sharedFolderGrants: [
    { path: "/tmp/output", access: "read-write", defaultOutput: true },
  ] }));
});

it("clears the output destination when its folder becomes read-only", async () => {
  const { update } = setup();
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Access for /tmp/output" })).getByRole("radio", { name: "Read-only" }));
  await waitFor(() => expect(update).toHaveBeenCalledWith("ava", { sharedFolderGrants: [
    { path: "/tmp/output", access: "read", defaultOutput: false },
    { path: "/tmp/input", access: "read", defaultOutput: false },
  ] }));
});

it("does not grant cancelled folders and lets a failed grant be retried", async () => {
  const { update } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Add folder…" }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  expect(update).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Add folder…" }));
  update.mockRejectedValueOnce(new Error("Folder unavailable"));
  fireEvent.click(await screen.findByRole("button", { name: "Grant access" }));
  await screen.findByText("Folder unavailable");
  expect(screen.getByRole("radiogroup", { name: "Access for selected folders" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Grant access" }));
  await waitFor(() => expect(screen.queryByRole("radiogroup", { name: "Access for selected folders" })).toBeNull());
});
