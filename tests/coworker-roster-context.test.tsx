// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoworkerRosterItem } from "@renderer/pages/CoworkerDetailPage";
import type { Coworker } from "@shared/contracts";

afterEach(() => cleanup());

const coworker: Coworker = {
  id: "coworker-1",
  name: "Ava",
  role: "Accounting",
  description: "Prepares invoices.",
  systemPrompt: "Work carefully.",
  modelProvider: "demo",
  modelName: "faux-1",
  status: "active",
  runtimeStatus: "IDLE",
  workspacePath: "/tmp/ava",
  enabledTools: [],
  enabledSkillIds: [],
  policies: {},
  sharedFolders: [],
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z",
};

describe("coworker roster context actions", () => {
  it("opens a context action on right-click while preserving normal selection", () => {
    const onSelect = vi.fn();
    const onOpenContextMenu = vi.fn();
    render(
      <CoworkerRosterItem
        coworker={coworker}
        onOpenContextMenu={onOpenContextMenu}
        onSelect={onSelect}
        selected
        waiting={0}
      />,
    );

    const item = screen.getByRole("button", { name: /Ava/ });
    fireEvent.contextMenu(item, { clientX: 120, clientY: 180 });
    expect(onOpenContextMenu).toHaveBeenCalledWith({ x: 120, y: 180 });
    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledOnce();
  });
});
