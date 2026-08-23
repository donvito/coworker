// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "@renderer/pages/SettingsPage";

afterEach(() => cleanup());

describe("web search credentials", () => {
  it("saves the key for the provider card the user selected", async () => {
    const configureWebSearch = vi.fn().mockResolvedValue({ key: "web-search:exa" });
    Object.defineProperty(window, "coworker", {
      configurable: true,
      value: {
        app: { updateSettings: vi.fn() },
        integrations: {
          credentialStatus: vi.fn().mockResolvedValue({ configured: false }),
          configureWebSearch,
        },
        diagnostics: { listProviderErrors: vi.fn().mockResolvedValue([]) },
        skills: { installFromPackage: vi.fn() },
      },
    });

    render(
      <SettingsPage
        coworkers={[]}
        dataPath="/tmp/coworker-data"
        integrations={[]}
        onChanged={vi.fn().mockResolvedValue(undefined)}
        settings={{
          demoMode: false,
          launchAtLogin: false,
          runInBackground: true,
          globalOperatingInstructions: "Ask when information is missing.",
          defaultModelProvider: null,
          defaultModelName: null,
        }}
        skills={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    expect(screen.queryByRole("combobox", { name: "Search provider" })).toBeNull();

    const exa = screen.getByRole("button", { name: "Exa Not connected" });
    expect(exa.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(exa);
    expect(exa.getAttribute("aria-pressed")).toBe("true");

    fireEvent.change(screen.getByLabelText("Exa API key"), {
      target: { value: "exa-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save search key" }));

    await waitFor(() =>
      expect(configureWebSearch).toHaveBeenCalledWith({
        provider: "exa",
        apiKey: "exa-key",
      }),
    );
  });
});
