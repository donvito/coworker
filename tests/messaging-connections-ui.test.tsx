// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessagingConnections } from "@renderer/components/MessagingConnections";
import { telegramConnectionCount, discordConnectionCount } from "@renderer/components/Primitives";
import type { Coworker, Integration, TelegramIntegrationStatus, DiscordIntegrationStatus } from "@shared/contracts";

afterEach(cleanup);
const coworkers = ["ava", "ben"].map(id => ({ id, name: id === "ava" ? "Ava" : "Ben", role: "Assistant" } as Coworker));
function integration(id: string, type: "telegram" | "discord", coworkerId = id.endsWith("2") ? "ben" : "ava"): Integration {
  return { id, name: `${type}-${id}`, type, mode: "bot", status: "connected", credentialKey: `key-${id}`,
    config: { coworkerId, ...(type === "telegram" ? { chatId: 123 } : { guildId: "10", channelId: "100" }) }, createdAt: "", updatedAt: "" };
}
function props() {
  return {
    coworkers, working: false,
    telegram: ["t1", "t2"].map(id => ({ integration: integration(id, "telegram"), pairingLink: null } as TelegramIntegrationStatus)),
    discord: ["d1", "d2"].map(id => ({ integration: integration(id, "discord"), inviteUrl: null, pairingCode: null, intentSettingsUrl: null } as DiscordIntegrationStatus)),
    onTelegramConfigure: vi.fn().mockResolvedValue(undefined), onDiscordConfigure: vi.fn().mockResolvedValue(undefined),
    onTelegramUnpair: vi.fn().mockResolvedValue(undefined), onTelegramDisconnect: vi.fn().mockResolvedValue(undefined),
    onDiscordUnpair: vi.fn().mockResolvedValue(undefined), onDiscordDisconnect: vi.fn().mockResolvedValue(undefined),
  };
}

describe("multiple bot connection settings", () => {
  it.each(["Telegram", "Discord"] as const)("adds another %s bot without an existing integration ID", async provider => {
    const input = props();
    if (provider === "Telegram") input.telegram = input.telegram.slice(0, 1);
    else input.discord = input.discord.slice(0, 1);
    render(<MessagingConnections {...input} />);
    fireEvent.click(screen.getByRole("button", { name: `Add ${provider} bot` }));
    const form = screen.getByRole("form", { name: `Add ${provider} bot connection` });
    fireEvent.change(within(form).getByLabelText("Bot token"), { target: { value: "new-token" } });
    fireEvent.change(within(form).getByLabelText("Linked coworker"), { target: { value: "ben" } });
    fireEvent.submit(form);
    const save = provider === "Telegram" ? input.onTelegramConfigure : input.onDiscordConfigure;
    await waitFor(() => expect(save).toHaveBeenCalledWith({ coworkerId: "ben", botToken: "new-token" }));
    expect(save.mock.calls[0]![0]).not.toHaveProperty("integrationId");
  });

  it("keeps same-platform coworkers independent and blocks a full slot", async () => {
    const input = props(); render(<MessagingConnections {...input} />);
    const row = screen.getByRole("region", { name: "Telegram telegram-t2" });
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    const select = within(row).getByLabelText("Linked coworker") as HTMLSelectElement;
    expect([...select.options].map(option => option.value)).toEqual(["ben"]);
    expect((screen.getByRole("button", { name: "Add Telegram bot" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(row).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(row).getByRole("button", { name: "Unpair" }));
    await waitFor(() => expect(input.onTelegramUnpair).toHaveBeenCalledWith("t2"));
    expect(input.onTelegramDisconnect).not.toHaveBeenCalled();
  });

  it("allows one Telegram and one Discord connection on the same coworker", () => {
    const input = props();
    input.telegram = input.telegram.slice(0, 1);
    input.discord = input.discord.slice(0, 1);
    render(<MessagingConnections {...input} />);
    expect(screen.getByRole("region", { name: "Telegram telegram-t1" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Discord discord-d1" })).toBeTruthy();
    expect(screen.getByLabelText("Telegram connected")).toBeTruthy();
    expect(screen.getByLabelText("Discord connected")).toBeTruthy();
  });

  it("preserves the form and entered token on a failed save", async () => {
    const input = props(); input.onDiscordConfigure.mockRejectedValue(new Error("Token rejected"));
    render(<MessagingConnections {...input} />);
    const row = screen.getByRole("region", { name: "Discord discord-d2" });
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    const token = within(row).getByLabelText("Replace bot token (optional)") as HTMLInputElement;
    fireEvent.change(token, { target: { value: "bad-token" } });
    fireEvent.submit(within(row).getByRole("form"));
    await waitFor(() => expect(within(row).getByRole("alert").textContent).toBe("Token rejected"));
    expect(token.value).toBe("bad-token");
    expect(within(row).getByRole("button", { name: "Save changes" })).toBeTruthy();
  });

  it("shows each bot's pairing instructions and scopes disconnect errors", async () => {
    const input = props();
    input.telegram[1]!.pairingLink = "https://t.me/second?start=pair-second";
    input.telegram[1]!.integration.config.chatId = null;
    Object.assign(input.discord[1]!, { pairingCode: "pair-second-discord", inviteUrl: "https://discord.com/oauth2/authorize?client_id=2", intentSettingsUrl: "https://discord.com/developers/applications/2/bot" });
    input.discord[1]!.integration.config.channelId = null;
    input.onDiscordDisconnect.mockRejectedValue(new Error("Disconnect failed"));
    render(<MessagingConnections {...input} />);
    const telegram = screen.getByRole("region", { name: "Telegram telegram-t2" });
    expect(within(telegram).getByRole("link", { name: "Pair Telegram chat" }).getAttribute("href")).toContain("pair-second");
    const discord = screen.getByRole("region", { name: "Discord discord-d2" });
    expect(within(discord).getByText("pair-second-discord")).toBeTruthy();
    expect(within(discord).getByRole("link", { name: "Invite this bot to your server" })).toBeTruthy();
    fireEvent.click(within(discord).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(input.onDiscordDisconnect).toHaveBeenCalledWith("d2"));
    await waitFor(() => expect(within(discord).getByRole("alert").textContent).toBe("Disconnect failed"));
  });

  it("blocks reconnect when the coworker's platform slot is occupied", async () => {
    const input = props(); input.coworkers = coworkers.slice(0, 1); input.telegram[1]!.integration.status = "disconnected"; input.telegram[1]!.integration.config.coworkerId = "ava";
    render(<MessagingConnections {...input} />);
    const row = screen.getByRole("region", { name: "Telegram telegram-t2" });
    expect((within(row).getByRole("button", { name: "Reconnect" }) as HTMLButtonElement).disabled).toBe(true);
    const rows = [...input.telegram, ...input.discord].map(status => status.integration);
    expect(telegramConnectionCount(rows, "ava")).toBe(1);
    expect(discordConnectionCount(rows, "ava")).toBe(1);
  });
});

it("keeps the displayed owner while offering a free coworker for reconnect", async () => {
  const input = props();
  input.telegram[1]!.integration.status = "disconnected";
  input.telegram[1]!.integration.config.coworkerId = "ava";
  render(<MessagingConnections {...input} />);
  const row = screen.getByRole("region", { name: "Telegram telegram-t2" });
  expect(within(row).getByText("telegram-t2 ⇄ Ava")).toBeTruthy();
  fireEvent.click(within(row).getByRole("button", { name: "Reconnect" }));
  expect((within(row).getByLabelText("Linked coworker") as HTMLSelectElement).value).toBe("ben");
  fireEvent.change(within(row).getByLabelText("Bot token"), { target: { value: "replacement-token" } });
  fireEvent.submit(within(row).getByRole("form"));
  await waitFor(() => expect(input.onTelegramConfigure).toHaveBeenCalledWith({ integrationId: "t2", coworkerId: "ben", botToken: "replacement-token" }));
});

it("lets a user choose a paused legacy bot using its retained token", async () => {
  const input = props();
  for (const status of input.telegram) {
    status.integration.status = "disconnected";
    status.integration.config.coworkerId = "ava";
    status.integration.config.connectionLimitConflict = true;
  }
  render(<MessagingConnections {...input} />);
  const row = screen.getByRole("region", { name: "Telegram telegram-t2" });
  fireEvent.click(within(row).getByRole("button", { name: "Reconnect" }));
  expect((within(row).getByLabelText("Bot token") as HTMLInputElement).required).toBe(false);
  fireEvent.submit(within(row).getByRole("form"));
  await waitFor(() => expect(input.onTelegramConfigure).toHaveBeenCalledWith({ integrationId: "t2", coworkerId: "ava", botToken: undefined }));
});
