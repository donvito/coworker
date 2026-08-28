// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CreateGroupChannelModal,
  latestDirectConversation,
  mentionedCoworkerIdsInText,
} from "@renderer/pages/CoworkerDetailPage";
import type { Conversation, Coworker, DesktopApi } from "@shared/contracts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function coworker(id: string, name: string): Coworker {
  return {
    id,
    name,
    role: `${name} specialist`,
    description: null,
    systemPrompt: `You are ${name}.`,
    modelProvider: "demo",
    modelName: "faux-1",
    status: "active",
    runtimeStatus: "IDLE",
    workspacePath: `/tmp/${id}`,
    enabledTools: [],
    enabledSkillIds: [],
    policies: {},
    sharedFolders: [],
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
}

describe("typed mentions", () => {
  const members = [
    { id: "ava", name: "Ava Chen" },
    { id: "sarah", name: "Sarah Miles" },
    { id: "sam", name: "Sam Ortiz" },
    { id: "sam2", name: "Sam Rivera" },
  ];

  it("recognizes typed mentions regardless of case", () => {
    expect(
      mentionedCoworkerIdsInText(
        "@ava can you work with @sarah on the marketing plan",
        members,
      ),
    ).toEqual(["ava", "sarah"]);
  });

  it("matches full names and keeps shared first names unambiguous", () => {
    expect(
      mentionedCoworkerIdsInText("@Sam Ortiz please review", members),
    ).toEqual(["sam"]);
    expect(mentionedCoworkerIdsInText("@Sam please review", members)).toEqual([]);
  });

  it("does not match partial words or bare text", () => {
    expect(mentionedCoworkerIdsInText("@Sarahs plan looks good", members)).toEqual([]);
    expect(mentionedCoworkerIdsInText("ava should do it", members)).toEqual([]);
  });
});

describe("group channel creation", () => {
  it("opens a coworker's direct chat instead of their newer group channel", () => {
    const direct: Conversation = {
      id: "direct-ava",
      coworkerId: "ava",
      kind: "direct",
      memberIds: ["ava"],
      title: "Ava",
      archivedAt: null,
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    };
    const group: Conversation = {
      id: "group-newer",
      coworkerId: null,
      kind: "group",
      memberIds: ["ava", "sarah"],
      title: "Launch",
      archivedAt: null,
      createdAt: "2026-08-24T01:00:00.000Z",
      updatedAt: "2026-08-24T01:00:00.000Z",
    };

    expect(latestDirectConversation([group, direct], "ava")).toEqual(direct);
  });

  it("requires and submits two selected coworkers", async () => {
    const ava = coworker("ava", "Ava");
    const sarah = coworker("sarah", "Sarah");
    const created: Conversation = {
      id: "channel-1",
      coworkerId: null,
      kind: "group",
      memberIds: [ava.id, sarah.id],
      title: "Launch",
      archivedAt: null,
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    };
    const create = vi.fn().mockResolvedValue(created);
    Object.defineProperty(window, "coworker", {
      configurable: true,
      value: {
        conversations: { create },
      } as unknown as DesktopApi,
    });
    const onCreated = vi.fn().mockResolvedValue(undefined);

    render(
      <CreateGroupChannelModal
        coworkers={[ava, sarah]}
        initialCoworkerId={ava.id}
        onClose={vi.fn()}
        onCreated={onCreated}
      />,
    );

    fireEvent.change(screen.getByLabelText("Channel name"), {
      target: { value: "Launch" },
    });
    fireEvent.click(screen.getAllByRole("checkbox")[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Create channel" }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        kind: "group",
        memberIds: [ava.id, sarah.id],
        title: "Launch",
      }),
    );
    expect(onCreated).toHaveBeenCalledWith(created);
  });
});
