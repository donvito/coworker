// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CoworkerSettingsModal,
  revealFolderLabel,
} from "@renderer/components/CoworkerSettingsModal";
import type { Coworker } from "@shared/contracts";

afterEach(() => cleanup());

const coworker: Coworker = {
  id: "coworker-1",
  name: "Ava",
  role: "Accounting",
  description: null,
  systemPrompt: "Work carefully.",
  modelProvider: "openrouter",
  modelName: "vendor/model-1",
  status: "active",
  runtimeStatus: "IDLE",
  workspacePath: "/tmp/ava",
  enabledTools: [],
  enabledSkillIds: [],
  policies: {},
  sharedFolders: [{ path: "/Users/melvin/Reports", alias: "Reports" }],
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z",
};

function mockDesktopApi() {
  const update = vi.fn().mockResolvedValue(coworker);
  const pick = vi.fn().mockResolvedValue(["/Users/melvin/Contracts"]);
  const reveal = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, "coworker", {
    configurable: true,
    value: {
      platform: "darwin",
      coworkers: { update },
      folders: { pick, reveal },
      integrations: {
        listModels: vi
          .fn()
          .mockResolvedValue([
            { id: "vendor/model-1", name: "Model 1", supportsImages: false },
          ]),
      },
    },
  });
  return { update, pick, reveal };
}

describe("coworker folder access settings", () => {
  it("labels the reveal action per platform", () => {
    expect(revealFolderLabel("darwin")).toBe("Reveal in Finder");
    expect(revealFolderLabel("win32")).toBe("Show in Explorer");
    expect(revealFolderLabel("linux")).toBe("Open folder");
  });

  it("shows granted folders and opens them in the OS file manager", async () => {
    const { reveal } = mockDesktopApi();
    render(
      <CoworkerSettingsModal
        coworker={coworker}
        onChanged={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
        onRemoved={vi.fn()}
        skills={[]}
      />,
    );

    expect(screen.getByText("Reports")).toBeTruthy();
    expect(screen.getByText("/Users/melvin/Reports")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reveal in Finder" }));
    await waitFor(() =>
      expect(reveal).toHaveBeenCalledWith("coworker-1", "/Users/melvin/Reports"),
    );
  });

  it("adds picked folders, removes rows, and saves the grant list", async () => {
    const { update, pick } = mockDesktopApi();
    const onChanged = vi.fn().mockResolvedValue(undefined);
    render(
      <CoworkerSettingsModal
        coworker={coworker}
        onChanged={onChanged}
        onClose={vi.fn()}
        onRemoved={vi.fn()}
        skills={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add folder…" }));
    await waitFor(() => expect(pick).toHaveBeenCalledOnce());
    expect(await screen.findByText("Contracts")).toBeTruthy();
    // Unsaved grants cannot be revealed yet.
    expect(screen.getByText("Added on save")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Reveal in Finder" })).toHaveLength(1);

    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update.mock.calls[0]?.[1]).toMatchObject({
      sharedFolderPaths: ["/Users/melvin/Reports", "/Users/melvin/Contracts"],
    });
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("saves folder grants without a model and links to model settings", async () => {
    const { update } = mockDesktopApi();
    const onOpenModelSettings = vi.fn();
    const demoCoworker: Coworker = { ...coworker, modelProvider: "demo", modelName: "faux-1" };
    render(
      <CoworkerSettingsModal
        coworker={demoCoworker}
        onChanged={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
        onOpenModelSettings={onOpenModelSettings}
        onRemoved={vi.fn()}
        skills={[]}
      />,
    );

    expect(screen.getByText("No model configured", { selector: "strong" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open model settings" }));
    expect(onOpenModelSettings).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    const patch = update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(patch.sharedFolderPaths).toEqual(["/Users/melvin/Reports"]);
    expect(patch).not.toHaveProperty("modelProvider");
    expect(patch).not.toHaveProperty("modelName");
  });

  it("drops a removed folder from the saved grants", async () => {
    const { update } = mockDesktopApi();
    render(
      <CoworkerSettingsModal
        coworker={coworker}
        onChanged={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
        onRemoved={vi.fn()}
        skills={[]}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Remove folder /Users/melvin/Reports" }),
    );
    expect(screen.getByText("No folders granted yet.")).toBeTruthy();

    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update.mock.calls[0]?.[1]).toMatchObject({ sharedFolderPaths: [] });
  });
});
