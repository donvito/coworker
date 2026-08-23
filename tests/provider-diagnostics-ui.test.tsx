// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "@renderer/pages/SettingsPage";

afterEach(() => cleanup());

describe("provider diagnostics settings", () => {
  it("shows recent errors and creates a copyable support report", async () => {
    const listProviderErrors = vi.fn().mockResolvedValue([
      {
        timestamp: "2026-08-23T11:00:00.000Z",
        level: "error",
        category: "model_provider",
        phase: "inference",
        provider: "openrouter",
        model: "google/gemini-test",
        taskId: "task-1",
        runId: "run-1",
        message: "404: No compatible endpoint",
        status: 404,
      },
    ]);
    const copyProviderReport = vi.fn().mockResolvedValue({ count: 1 });
    Object.defineProperty(window, "coworker", {
      configurable: true,
      value: {
        integrations: {
          credentialStatus: vi.fn().mockResolvedValue({ configured: false }),
        },
        diagnostics: {
          listProviderErrors,
          copyProviderReport,
          exportProviderReport: vi.fn().mockResolvedValue(null),
        },
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

    fireEvent.click(screen.getByRole("button", { name: "Data" }));
    expect(await screen.findByText("404: No compatible endpoint")).toBeTruthy();
    expect(listProviderErrors).toHaveBeenCalledWith(50);

    fireEvent.click(screen.getByRole("button", { name: "Copy report" }));
    await waitFor(() => expect(copyProviderReport).toHaveBeenCalledOnce());
    expect(screen.getByRole("status").textContent).toContain(
      "Copied a redacted report with 1 provider error.",
    );
  });
});
