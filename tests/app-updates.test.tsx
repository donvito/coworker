// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSnapshot, AppUpdateState, DesktopEvent } from "@shared/contracts";
import { AppUpdateSidebarButton } from "@renderer/components/AppUpdateSidebarButton";
import { AppUpdatesProvider } from "@renderer/state/AppUpdatesProvider";
import { AppDataProvider } from "@renderer/state/AppDataProvider";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const available: AppUpdateState = { checking: false, availableVersion: "0.8.0", notice: { kind: "available", version: "0.8.0" } };
const quiet: AppUpdateState = { checking: false, availableVersion: null, notice: null };
const updateButtonName = "Coworker 0.8.0 is available. View update";

function fixture(initialState = available) {
  let state = initialState;
  const listeners = new Set<(event: DesktopEvent) => void>();
  const getUpdateState = vi.fn().mockImplementation(async () => state);
  const openUpdateRelease = vi.fn().mockResolvedValue(undefined);
  const checkForUpdates = vi.fn();
  const emit = (next: AppUpdateState) => {
    state = next;
    for (const listener of listeners) listener({ type: "app.update", state });
  };
  const dismissUpdateNotice = vi.fn().mockImplementation(async () => {
    const next = { ...state, notice: null };
    emit(next);
    return next;
  });
  const unsubscribe = vi.fn();
  Object.defineProperty(window, "coworker", { configurable: true, value: {
    app: { getUpdateState, openUpdateRelease, dismissUpdateNotice, checkForUpdates },
    events: { subscribe: (listener: (event: DesktopEvent) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); unsubscribe(); };
    } },
  } });
  return { emit, getUpdateState, openUpdateRelease, dismissUpdateNotice, checkForUpdates, unsubscribe };
}

function Updates() {
  return <AppUpdatesProvider><AppUpdateSidebarButton /></AppUpdatesProvider>;
}

describe("app update modal and sidebar", () => {
  it("shows retained startup updates in a modal and opens the trusted release through IPC", async () => {
    const { openUpdateRelease } = fixture();
    render(<Updates />);
    const dialog = await screen.findByRole("dialog", { name: "Coworker 0.8.0 is available." });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(openUpdateRelease).toHaveBeenCalledExactlyOnceWith());
    expect(screen.getByRole("button", { name: "Later" })).toBeTruthy();
    expect(screen.getByRole("button", { name: updateButtonName }).querySelector("svg")).toBeTruthy();
  });

  it("retains the sidebar icon after Later and renderer remounts, and reopens without another network check", async () => {
    const { dismissUpdateNotice, checkForUpdates, openUpdateRelease, unsubscribe } = fixture();
    const view = render(<Updates />);
    fireEvent.click(await screen.findByRole("button", { name: "Later" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(dismissUpdateNotice).toHaveBeenCalledExactlyOnceWith();
    expect(screen.getByRole("button", { name: updateButtonName }).getAttribute("aria-expanded")).toBe("false");
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
    render(<Updates />);
    const updateButton = await screen.findByRole("button", { name: updateButtonName });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(updateButton);
    expect(screen.getByRole("dialog", { name: "Coworker 0.8.0 is available." })).toBeTruthy();
    expect(updateButton.getAttribute("aria-expanded")).toBe("true");
    expect(checkForUpdates).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(openUpdateRelease).toHaveBeenCalledExactlyOnceWith());
  });

  it("hides the icon when current and displays manual progress, the current-version modal, and a clear failure", async () => {
    const { emit } = fixture(quiet);
    render(<Updates />);
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: updateButtonName })).toBeNull();
    act(() => emit({ ...quiet, checking: true, notice: { kind: "checking" } }));
    expect(screen.getByRole("dialog", { name: "Checking for updates…" })).toBeTruthy();
    act(() => emit({ ...quiet, notice: { kind: "up-to-date" } }));
    expect(screen.getByRole("dialog", { name: "You’re up to date." })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    act(() => emit({ ...quiet, notice: { kind: "error", message: "Could not reach GitHub. Check your internet connection and try again." } }));
    expect(screen.getByRole("dialog", { name: "Could not check for updates." }).textContent).toMatch(/Could not reach GitHub/);
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
  });

  it("does not let a stale initial response overwrite a newer event", async () => {
    const { emit, getUpdateState } = fixture(quiet);
    let finish!: (state: AppUpdateState) => void;
    getUpdateState.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<Updates />);
    act(() => emit(available));
    await act(async () => finish(quiet));
    expect(screen.getByRole("dialog", { name: "Coworker 0.8.0 is available." })).toBeTruthy();
    expect(screen.getByRole("button", { name: updateButtonName })).toBeTruthy();
  });

  it("retains the modal and allows retry if the browser cannot open", async () => {
    const { openUpdateRelease } = fixture();
    openUpdateRelease.mockRejectedValue(new Error("Browser unavailable"));
    render(<Updates />);
    fireEvent.click(await screen.findByRole("button", { name: "Download" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not open the release page: Browser unavailable");
    expect(screen.getByRole("dialog", { name: "Coworker 0.8.0 is available." })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Download" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("preserves the draft, traps keyboard focus, and restores it after Escape", async () => {
    const { emit } = fixture(quiet);
    render(<AppUpdatesProvider><AppUpdateSidebarButton /><textarea aria-label="Message draft" defaultValue="Unfinished message" /></AppUpdatesProvider>);
    await act(async () => {});
    const draft = screen.getByRole("textbox") as HTMLTextAreaElement;
    draft.focus();
    act(() => emit(available));
    const download = screen.getByRole("button", { name: "Download" });
    const close = screen.getByRole("button", { name: "Dismiss update notice" });
    expect(document.activeElement).toBe(download);
    fireEvent.keyDown(download, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(download);
    fireEvent.keyDown(download, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("textbox")).toBe(draft);
    expect(draft.value).toBe("Unfinished message");
    expect(document.activeElement).toBe(draft);
    expect(screen.getByRole("button", { name: updateButtonName })).toBeTruthy();
  });

  it.each(["close", "backdrop"])("dismisses via %s while retaining the update icon", async (action) => {
    fixture();
    render(<Updates />);
    const dialog = await screen.findByRole("dialog");
    if (action === "close") fireEvent.click(screen.getByRole("button", { name: "Dismiss update notice" }));
    else fireEvent.mouseDown(dialog.parentElement!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: updateButtonName })).toBeTruthy();
  });

  it("keeps the known update accessible after a failed manual check, then hides it when no longer available", async () => {
    const { emit } = fixture(quiet);
    render(<Updates />);
    await act(async () => {});
    act(() => emit({ ...available, notice: { kind: "error", message: "Could not reach GitHub." } }));
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: updateButtonName }));
    expect(screen.getByRole("dialog", { name: "Coworker 0.8.0 is available." })).toBeTruthy();
    act(() => emit(quiet));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: updateButtonName })).toBeNull();
  });

  it("does not refresh coworker data for infrastructure update events", async () => {
    const { emit } = fixture(quiet);
    const snapshot = { coworkers: [] } as unknown as AppSnapshot;
    const bootstrap = vi.fn().mockResolvedValue(snapshot);
    window.coworker.app.bootstrap = bootstrap;
    render(<AppDataProvider><Updates /></AppDataProvider>);
    await waitFor(() => expect(bootstrap).toHaveBeenCalledOnce());
    act(() => emit(available));
    await screen.findByRole("button", { name: "Later" });
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(bootstrap).toHaveBeenCalledOnce();
  });
});
