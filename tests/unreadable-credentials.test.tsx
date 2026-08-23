// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "@renderer/pages/SettingsPage";

afterEach(() => cleanup());

function renderSettings(overrides: Record<string, unknown>) {
  Object.defineProperty(window, "coworker", {
    configurable: true,
    value: {
      app: { updateSettings: vi.fn() },
      diagnostics: { listProviderErrors: vi.fn().mockResolvedValue([]) },
      skills: { installFromPackage: vi.fn() },
      ...overrides,
    },
  });

  return render(
    <SettingsPage
      coworkers={[]}
      dataPath="/tmp/coworker-data"
      integrations={[]}
      onChanged={vi.fn().mockResolvedValue(undefined)}
      settings={{
        demoMode: false,
        launchAtLogin: false,
        runInBackground: true,
        theme: "forest",
        showReasoning: true,
        globalOperatingInstructions: "Ask when information is missing.",
        defaultModelProvider: null,
        defaultModelName: null,
      }}
      skills={[]}
    />,
  );
}

describe("credentials encrypted under a previous app identity", () => {
  it("names the affected credential and where it lives", async () => {
    const removeCredential = vi.fn().mockResolvedValue(undefined);
    renderSettings({
      integrations: {
        credentialStatus: vi.fn().mockImplementation(async (key: string) => ({
          key,
          configured: false,
          needsReentry: key === "web-search:firecrawl",
        })),
        removeCredential,
      },
    });

    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("1 saved credential");
    expect(banner.textContent).toContain("Firecrawl web search key");
    // The Firecrawl key lives under Skills, not Models or Integrations.
    expect(banner.textContent).toContain("Open Skills");
  });

  it("discards the unreadable credential so the banner clears", async () => {
    const removeCredential = vi.fn().mockResolvedValue(undefined);
    renderSettings({
      integrations: {
        credentialStatus: vi.fn().mockImplementation(async (key: string) => ({
          key,
          configured: false,
          needsReentry: key === "web-search:firecrawl",
        })),
        removeCredential,
      },
    });

    const discard = await screen.findByRole("button", {
      name: "Discard unreadable credential",
    });
    fireEvent.click(discard);

    await waitFor(() =>
      expect(removeCredential).toHaveBeenCalledExactlyOnceWith("web-search:firecrawl"),
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByRole("status").textContent).toContain(
      "Discarded 1 unreadable credential",
    );
  });

  it("stays quiet when every credential decrypts", async () => {
    renderSettings({
      integrations: {
        credentialStatus: vi.fn().mockImplementation(async (key: string) => ({
          key,
          configured: true,
        })),
        removeCredential: vi.fn(),
      },
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Models" })).toBeTruthy(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
