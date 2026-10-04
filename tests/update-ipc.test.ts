import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { DesktopAppService } from "@main/app/app-service";
import type { CredentialStore } from "@main/security/credential-store";
import { AppUpdateChecker } from "@main/app/update-checker";
import { registerIpc } from "@main/ipc/register-ipc";
import { ipcChannels } from "@shared/ipc";

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;
const mocks = vi.hoisted(() => ({
  handle: vi.fn<(channel: string, handler: IpcHandler) => void>(),
  removeHandler: vi.fn<(channel: string) => void>(),
}));
vi.mock("electron", () => ({
  ipcMain: mocks,
  app: {}, BrowserWindow: {}, clipboard: {}, dialog: {}, shell: {},
}));
vi.mock("@main/control/administration", () => ({ createAdministration: () => ({ channels: [], has: () => false }) }));

afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

function fixture() {
  vi.stubEnv("ELECTRON_RENDERER_URL", undefined);
  const frame = { url: "file:///app/renderer/index.html" };
  const sender = { id: 7, mainFrame: frame };
  const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const send = vi.fn();
  const window = { isDestroyed: () => false, webContents: { ...sender, send } } as unknown as BrowserWindow;
  const serviceUnsubscribe = vi.fn();
  const service = { subscribe: vi.fn(() => serviceUnsubscribe) } as unknown as DesktopAppService;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify([
    { tag_name: "v0.8.0", draft: false, prerelease: false, html_url: "https://evil.example/download" },
  ])));
  const openExternal = vi.fn().mockResolvedValue(undefined);
  const updates = new AppUpdateChecker({ currentVersion: "0.7.0", fetcher, openExternal });
  const unregister = registerIpc({ service, credentials: {} as CredentialStore, getMainWindow: () => window, updates });
  const handlers = new Map<string, IpcHandler>(mocks.handle.mock.calls);
  return { handlers, event, updates, send, unregister, serviceUnsubscribe, fetcher, openExternal };
}

describe("update IPC", () => {
  it("bridges checks, state, dismissal, and trusted release opening through existing channels", async () => {
    const { handlers, event, updates, send, unregister, openExternal, serviceUnsubscribe } = fixture();
    try {
      expect(await handlers.get(ipcChannels.getUpdateState)!(event)).toEqual({ checking: false, availableVersion: null, notice: null });
      expect(await handlers.get(ipcChannels.checkForUpdates)!(event)).toEqual({ checking: false, availableVersion: "0.8.0", notice: { kind: "available", version: "0.8.0" } });
      expect(send).toHaveBeenLastCalledWith(ipcChannels.event, { type: "app.update", state: updates.getState() });
      await handlers.get(ipcChannels.openUpdateRelease)!(event, "https://evil.example/download");
      expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://github.com/donvito/coworker/releases/tag/v0.8.0");
      expect(await handlers.get(ipcChannels.dismissUpdateNotice)!(event)).toEqual({ checking: false, availableVersion: "0.8.0", notice: null });
    } finally {
      unregister();
    }
    expect(serviceUnsubscribe).toHaveBeenCalledOnce();
    expect(mocks.removeHandler).toHaveBeenCalledWith(ipcChannels.checkForUpdates);
    const eventCount = send.mock.calls.length;
    await updates.check(true);
    expect(send).toHaveBeenCalledTimes(eventCount);
  });

  it("rejects unknown renderers and child frames before networking or opening links", async () => {
    const { handlers, event, fetcher, openExternal, unregister } = fixture();
    try {
      const unknown = { ...event, sender: { ...event.sender, id: 999 } } as IpcMainInvokeEvent;
      await expect(handlers.get(ipcChannels.checkForUpdates)!(unknown)).rejects.toThrow("unknown renderer");
      const child = { ...event, senderFrame: { url: "file:///app/child.html" } } as IpcMainInvokeEvent;
      await expect(handlers.get(ipcChannels.openUpdateRelease)!(child)).rejects.toThrow("child frame");
      expect(fetcher).not.toHaveBeenCalled();
      expect(openExternal).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });
});
