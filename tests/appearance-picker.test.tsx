// @vitest-environment happy-dom

import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, AppSnapshot } from "@shared/contracts";
import { AppearancePicker } from "@renderer/components/AppearancePicker";
import { AppDataProvider } from "@renderer/state/AppDataProvider";

afterEach(() => cleanup());

const initialSettings: AppSettings = {
  demoMode: false,
  launchAtLogin: false,
  runInBackground: true,
  theme: "forest",
  colorMode: "light",
  showReasoning: true,
  globalOperatingInstructions: "Ask when information is missing.",
  defaultModelProvider: null,
  defaultModelName: null,
};

function mockAppearanceApi() {
  let settings = { ...initialSettings };
  const bootstrap = vi.fn(async (): Promise<AppSnapshot> => ({
    coworkers: [], conversations: [], discussions: [], tasks: [], messages: [],
    imageAttachments: [], approvals: [], schedules: [], artifacts: [], activity: [],
    integrations: [], modelEndpoints: [], skills: [], settings,
    dataPath: "/tmp/coworker-data", version: "0.5.0",
  }));
  const save = (patch: Partial<AppSettings>) => {
    settings = { ...settings, ...patch };
    return settings;
  };
  const updateSettings = vi.fn(async (patch: Partial<AppSettings>) => save(patch));
  Object.defineProperty(window, "coworker", {
    configurable: true,
    value: {
      app: { bootstrap, updateSettings },
      events: { subscribe: () => () => undefined },
    },
  });
  return { bootstrap, updateSettings, save };
}

function WorkspaceFixture() {
  const [draft, setDraft] = useState("");
  return (
    <main>
      <h1>Workspace</h1>
      <AppearancePicker />
      <textarea aria-label="Message draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
      <button type="button">Continue working</button>
    </main>
  );
}

async function openPicker() {
  render(<AppDataProvider><WorkspaceFixture /></AppDataProvider>);
  const trigger = await screen.findByRole("button", { name: "Appearance: Forest, Light" });
  fireEvent.click(trigger);
  return { trigger, dialog: screen.getByRole("dialog", { name: "Appearance" }) };
}

describe("quick appearance picker", () => {
  it("changes mode and theme independently while retaining the open picker and surrounding draft", async () => {
    const { bootstrap, updateSettings } = mockAppearanceApi();
    const { trigger, dialog } = await openPicker();
    const draft = screen.getByRole("textbox", { name: "Message draft" }) as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "Keep this unfinished message" } });
    const modes = within(within(dialog).getByRole("group", { name: "Color mode" }));
    const themes = within(within(dialog).getByRole("group", { name: "Color theme" }));
    expect(modes.getAllByRole("button").map((button) => button.textContent)).toEqual(["Light", "Dark", "System"]);
    expect(themes.getAllByRole("button").map((button) => button.textContent).sort())
      .toEqual(["Clay", "Forest", "Graphite", "Ocean", "Plum"]);

    fireEvent.click(modes.getByRole("button", { name: "Dark" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Appearance: Forest, Dark" })).toBe(trigger));
    expect(updateSettings).toHaveBeenNthCalledWith(1, { colorMode: "dark" });
    expect(themes.getByRole("button", { name: "Forest" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(themes.getByRole("button", { name: "Ocean" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Appearance: Ocean, Dark" })).toBe(trigger));
    expect(updateSettings).toHaveBeenNthCalledWith(2, { theme: "ocean" });
    expect(modes.getByRole("button", { name: "Dark" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(modes.getByRole("button", { name: "System" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Appearance: Ocean, System" })).toBe(trigger));
    expect(updateSettings).toHaveBeenNthCalledWith(3, { colorMode: "system" });
    expect(bootstrap).toHaveBeenCalledTimes(4);
    expect(screen.getByRole("dialog", { name: "Appearance" })).toBe(dialog);
    expect(screen.getByRole("heading", { name: "Workspace" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Message draft" })).toBe(draft);
    expect(draft.value).toBe("Keep this unfinished message");
  });

  it("prevents overlapping saves until the selection has been persisted and refreshed", async () => {
    const { bootstrap, updateSettings, save } = mockAppearanceApi();
    let finishSave!: () => void;
    const pending = new Promise<void>((resolve) => { finishSave = resolve; });
    updateSettings.mockImplementationOnce(async (patch) => {
      await pending;
      return save(patch);
    });
    const { dialog } = await openPicker();
    const options = within(dialog).getAllByRole("button").filter((button) => button.hasAttribute("aria-pressed"));

    fireEvent.click(within(dialog).getByRole("button", { name: "Dark" }));
    expect(options).toHaveLength(8);
    expect(options.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Ocean" }));
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "Appearance" })).toBe(dialog);

    await act(async () => { finishSave(); await pending; });
    await waitFor(() => expect(options.every((button) => !(button as HTMLButtonElement).disabled)).toBe(true));
    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(within(dialog).getByRole("button", { name: "Dark" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the saved appearance after failure and allows the failed choice to be retried", async () => {
    const { bootstrap, updateSettings } = mockAppearanceApi();
    updateSettings.mockRejectedValueOnce(new Error("Could not save appearance"));
    const { trigger, dialog } = await openPicker();
    const ocean = within(dialog).getByRole("button", { name: "Ocean" }) as HTMLButtonElement;

    fireEvent.click(ocean);
    expect((await screen.findByRole("alert")).textContent).toContain("Could not save appearance");
    expect(screen.getByRole("button", { name: "Appearance: Forest, Light" })).toBe(trigger);
    expect(ocean.getAttribute("aria-pressed")).toBe("false");
    expect(ocean.disabled).toBe(false);
    expect(bootstrap).toHaveBeenCalledTimes(1);

    fireEvent.click(ocean);
    await waitFor(() => expect(screen.getByRole("button", { name: "Appearance: Ocean, Light" })).toBe(trigger));
    expect(updateSettings).toHaveBeenNthCalledWith(1, { theme: "ocean" });
    expect(updateSettings).toHaveBeenNthCalledWith(2, { theme: "ocean" });
    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Appearance" })).toBe(dialog);
  });

  it.each(["Escape", "close button"])("returns focus to the trigger when dismissed with %s", async (dismissal) => {
    mockAppearanceApi();
    const { trigger, dialog } = await openPicker();
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Light" })));

    if (dismissal === "Escape") {
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    } else {
      fireEvent.click(within(dialog).getByRole("button", { name: "Close appearance picker" }));
    }

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Appearance" })).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("dismisses on outside pointer or focus movement without pulling focus away from the workspace", async () => {
    mockAppearanceApi();
    const { trigger } = await openPicker();
    const outside = screen.getByRole("button", { name: "Continue working" });
    fireEvent.pointerDown(outside);
    expect(screen.queryByRole("dialog", { name: "Appearance" })).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Appearance" })).toBeTruthy();
    act(() => outside.focus());
    expect(screen.queryByRole("dialog", { name: "Appearance" })).toBeNull();
    expect(document.activeElement).toBe(outside);
  });
});
