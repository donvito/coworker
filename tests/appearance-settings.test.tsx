// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@shared/contracts";
import { SettingsPage } from "@renderer/pages/SettingsPage";

afterEach(() => cleanup());

const settings: AppSettings = {
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

function mockSettingsApi() {
  const updateSettings = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, "coworker", {
    configurable: true,
    value: {
      app: { updateSettings },
      integrations: {
        credentialStatus: vi.fn().mockResolvedValue({ configured: false }),
      },
      diagnostics: { listProviderErrors: vi.fn().mockResolvedValue([]) },
    },
  });
  return updateSettings;
}

function settingsPage(currentSettings: AppSettings, onChanged = vi.fn().mockResolvedValue(undefined)) {
  return (
    <SettingsPage
      coworkers={[]}
      dataPath="/tmp/coworker-data"
      integrations={[]}
      onChanged={onChanged}
      settings={currentSettings}
      skills={[]}
    />
  );
}

describe("appearance settings", () => {
  it("changes color mode and color theme independently and reflects refreshed settings", async () => {
    const updateSettings = mockSettingsApi();
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(settingsPage(settings, onChanged));
    const modes = within(screen.getByRole("group", { name: "Color mode" }));
    const themes = within(screen.getByRole("group", { name: "Color theme" }));

    expect(modes.getByRole("button", { name: /^Light\b/ }).getAttribute("aria-pressed")).toBe("true");
    expect(themes.getByRole("button", { name: /^Forest\b/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(modes.getByRole("button", { name: /^Dark\b/ }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(updateSettings).toHaveBeenNthCalledWith(1, { colorMode: "dark" });
    rerender(settingsPage({ ...settings, colorMode: "dark" }, onChanged));
    expect(modes.getByRole("button", { name: /^Dark\b/ }).getAttribute("aria-pressed")).toBe("true");
    expect(modes.getByRole("button", { name: /^Light\b/ }).getAttribute("aria-pressed")).toBe("false");
    expect(themes.getByRole("button", { name: /^Forest\b/ }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(themes.getByRole("button", { name: /^Ocean\b/ }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    expect(updateSettings).toHaveBeenNthCalledWith(2, { theme: "ocean" });
    rerender(settingsPage({ ...settings, theme: "ocean", colorMode: "dark" }, onChanged));
    expect(themes.getByRole("button", { name: /^Ocean\b/ }).getAttribute("aria-pressed")).toBe("true");
    expect(modes.getByRole("button", { name: /^Dark\b/ }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(modes.getByRole("button", { name: /^System\b/ }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(3));
    expect(updateSettings).toHaveBeenNthCalledWith(3, { colorMode: "system" });
    rerender(settingsPage({ ...settings, theme: "ocean", colorMode: "system" }, onChanged));
    expect(modes.getByRole("button", { name: /^System\b/ }).getAttribute("aria-pressed")).toBe("true");
    expect(themes.getByRole("button", { name: /^Ocean\b/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it.each([
    { group: "Color mode", name: /^Dark\b/, patch: { colorMode: "dark" } },
    { group: "Color theme", name: /^Ocean\b/, patch: { theme: "ocean" } },
  ])("reports a failed $group save and lets the user retry", async ({ group, name, patch }) => {
    const updateSettings = mockSettingsApi();
    updateSettings.mockRejectedValueOnce(new Error("Could not save appearance"));
    const onChanged = vi.fn().mockResolvedValue(undefined);
    render(settingsPage(settings, onChanged));

    const button = within(screen.getByRole("group", { name: group })).getByRole("button", { name });
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toContain("Could not save appearance");
    expect(updateSettings).toHaveBeenCalledWith(patch);
    expect(onChanged).not.toHaveBeenCalled();
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(button);
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(updateSettings).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
