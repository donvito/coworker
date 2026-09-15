// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Coworker, DiscordIntegrationStatus, TelegramIntegrationStatus } from "@shared/contracts";
import { CoworkerMessagingSettings } from "@renderer/components/CoworkerMessagingSettings";
import { CoworkerSettingsModal } from "@renderer/components/CoworkerSettingsModal";

const coworker: Coworker = {
  id: "ava", name: "Ava", role: "Finance", description: null, systemPrompt: "Be useful.",
  modelProvider: "demo", modelName: "demo", status: "active", runtimeStatus: "IDLE",
  workspacePath: "/tmp/ava", enabledTools: [], enabledSkillIds: [], policies: {}, sharedFolders: [],
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};
const other: Coworker = { ...coworker, id: "bea", name: "Bea" };

function integration(type: "telegram" | "discord", id: string, owner: string, extra: Record<string, unknown> = {}) {
  return { id, type, name: `${type}-${id}`, mode: "bot" as const, status: "connected" as const,
    credentialKey: `${type}:${id}`, config: { coworkerId: owner, ...extra }, createdAt: "", updatedAt: "" };
}

function telegramStatus(id: string, owner: string, paired = false): TelegramIntegrationStatus {
  return { integration: integration("telegram", id, owner, paired ? { chatId: 42 } : {}), pairingLink: paired ? null : "https://t.me/pair" };
}
function discordStatus(id: string, owner: string, paired = false): DiscordIntegrationStatus {
  return { integration: integration("discord", id, owner, paired ? { channelId: "channel" } : {}), inviteUrl: "https://discord.test/invite", pairingCode: paired ? null : "PAIR", intentSettingsUrl: null };
}

function installApi(overrides: Record<string, unknown> = {}) {
  const subscribe = vi.fn().mockReturnValue(vi.fn());
  const api: any = {
    events: { subscribe },
    integrations: {
      telegramStatus: vi.fn().mockResolvedValue([]), discordStatus: vi.fn().mockResolvedValue([]),
      configureTelegram: vi.fn().mockResolvedValue(telegramStatus("new-tg", "ava")),
      configureDiscord: vi.fn().mockResolvedValue(discordStatus("new-dc", "ava")),
      unpairTelegram: vi.fn().mockResolvedValue(telegramStatus("tg", "ava")), disconnectTelegram: vi.fn().mockResolvedValue(undefined),
      unpairDiscord: vi.fn().mockResolvedValue(discordStatus("dc", "ava")), disconnectDiscord: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
  Object.defineProperty(window, "coworker", { configurable: true, value: api });
  return api;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("coworker messaging settings", () => {
  it("shows only the current coworker's Telegram and Discord rows", async () => {
    const api = installApi();
    api.integrations.telegramStatus.mockResolvedValue([telegramStatus("mine", "ava"), telegramStatus("other", "bea")]);
    api.integrations.discordStatus.mockResolvedValue([discordStatus("mine-dc", "ava"), discordStatus("other-dc", "bea")]);
    render(<CoworkerMessagingSettings coworker={coworker} onChanged={vi.fn().mockResolvedValue(undefined)} />);
    await waitFor(() => expect(screen.getByText("telegram-mine ⇄ Ava")).toBeTruthy());
    expect(screen.queryByText("telegram-other ⇄ Bea")).toBeNull();
    expect(screen.getByText("discord-mine-dc ⇄ Ava")).toBeTruthy();
    expect(screen.queryByText("discord-other-dc ⇄ Bea")).toBeNull();
  });

  it("uses the current coworker as owner for both create operations and refreshes", async () => {
    const api = installApi();
    const onChanged = vi.fn().mockResolvedValue(undefined);
    render(<CoworkerMessagingSettings coworker={coworker} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Add Telegram bot" })).toBeTruthy());
    fireEvent.click(screen.getAllByRole("button", { name: "Add Telegram bot" })[0]!);
    fireEvent.change(screen.getByLabelText("Bot token"), { target: { value: "tg-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect Telegram bot" }));
    await waitFor(() => expect(api.integrations.configureTelegram).toHaveBeenCalledWith({ botToken: "tg-secret", coworkerId: "ava" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());

    fireEvent.click(screen.getAllByRole("button", { name: "Add Discord bot" })[0]!);
    fireEvent.change(screen.getByLabelText("Bot token"), { target: { value: "dc-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect Discord bot" }));
    await waitFor(() => expect(api.integrations.configureDiscord).toHaveBeenCalledWith({ botToken: "dc-secret", coworkerId: "ava" }));
  });

  it("refreshes paired rows when an integration event arrives", async () => {
    const api = installApi();
    let paired = false;
    api.integrations.telegramStatus.mockImplementation(() => Promise.resolve([telegramStatus("tg", "ava", paired)]));
    render(<CoworkerMessagingSettings coworker={coworker} onChanged={vi.fn().mockResolvedValue(undefined)} />);
    await waitFor(() => expect(screen.getByRole("region", { name: "Telegram telegram-tg" }).textContent).toContain("Waiting to pair"));
    paired = true;
    const handler = api.events.subscribe.mock.calls[0]![0];
    handler({ type: "entity.changed", entity: "integrations" });
    await waitFor(() => expect(screen.getByRole("region", { name: "Telegram telegram-tg" }).textContent).toContain("Paired"));
  });

  it("clears failed loads and disables stale actions", async () => {
    const api = installApi();
    api.integrations.telegramStatus.mockResolvedValue([telegramStatus("tg", "ava")]);
    render(<CoworkerMessagingSettings coworker={coworker} onChanged={vi.fn().mockResolvedValue(undefined)} />);
    await waitFor(() => expect(screen.getByText("telegram-tg ⇄ Ava")).toBeTruthy());
    api.integrations.telegramStatus.mockRejectedValue(new Error("status unavailable"));
    const handler = api.events.subscribe.mock.calls[0]![0];
    handler({ type: "entity.changed", entity: "integrations" });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Telegram telegram-tg" })).toBeNull());
    expect(screen.getByRole("alert").textContent).toContain("status unavailable");
    expect((screen.getByRole("button", { name: "Add Telegram bot" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps messaging forms outside the parent settings form", async () => {
    const api = installApi();
    api.integrations.listModels = vi.fn().mockResolvedValue([]);
    api.memory = { read: vi.fn().mockResolvedValue({ path: "MEMORY.md", content: "", revision: "0".repeat(64) }) };
    api.coworkers = { update: vi.fn(), remove: vi.fn() };
    api.folders = { pick: vi.fn(), reveal: vi.fn() };
    render(<CoworkerSettingsModal coworker={coworker} skills={[]} onChanged={vi.fn().mockResolvedValue(undefined)} onClose={vi.fn()} onRemoved={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Add Telegram bot" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Add Telegram bot" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Discord bot" }));
    expect(document.querySelectorAll("form")).toHaveLength(3);
    for (const form of document.querySelectorAll("form")) expect(form.querySelector("form")).toBeNull();
  });
});

it("preserves an open token editor when pairing status refreshes", async () => {
  const api = installApi();
  api.integrations.telegramStatus.mockResolvedValue([telegramStatus("tg", "ava")]);
  render(<CoworkerMessagingSettings coworker={coworker} onChanged={vi.fn().mockResolvedValue(undefined)} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const input = screen.getByLabelText("Replace bot token (optional)") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "unsaved-token" } });
  api.integrations.telegramStatus.mockResolvedValue([telegramStatus("tg", "ava", true)]);
  api.events.subscribe.mock.calls[0]![0]({ type: "entity.changed", entity: "integrations" });
  await waitFor(() => expect(screen.getByRole("region", { name: "Telegram telegram-tg" }).textContent).toContain("Paired"));
  expect(screen.getByLabelText("Replace bot token (optional)")).toBe(input);
  expect(input.value).toBe("unsaved-token");
});

it("ignores a pending status response after switching coworkers", async () => {
  const api = installApi();
  let release!: (rows: TelegramIntegrationStatus[]) => void;
  api.integrations.telegramStatus.mockImplementationOnce(() => new Promise<TelegramIntegrationStatus[]>(resolve => { release = resolve; }));
  api.integrations.telegramStatus.mockResolvedValue([telegramStatus("bea-bot", "bea")]);
  const onChanged = vi.fn().mockResolvedValue(undefined);
  const view = render(<CoworkerMessagingSettings coworker={coworker} onChanged={onChanged} />);
  view.rerender(<CoworkerMessagingSettings coworker={other} onChanged={onChanged} />);
  await waitFor(() => expect(screen.getByText("telegram-bea-bot ⇄ Bea")).toBeTruthy());
  release([telegramStatus("ava-bot", "ava")]);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(screen.queryByText("telegram-ava-bot ⇄ Bea")).toBeNull();
  expect(screen.getByText("telegram-bea-bot ⇄ Bea")).toBeTruthy();
});
