// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "@renderer/pages/SettingsPage";

afterEach(() => cleanup());

describe("skill package upload", () => {
  it("uploads .skill packages through the package installer", async () => {
    const installFromPackage = vi.fn().mockResolvedValue({ name: "release-notes" });
    const onChanged = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "coworker", {
      configurable: true,
      value: {
        app: { updateSettings: vi.fn() },
        integrations: {
          credentialStatus: vi.fn().mockResolvedValue({ configured: false }),
        },
        diagnostics: { listProviderErrors: vi.fn().mockResolvedValue([]) },
        skills: { installFromPackage },
      },
    });
    const archive = new JSZip();
    archive.file(
      "release-notes/skill.md",
      "---\nname: release-notes\ndescription: Writes release notes.\n---\n\n# Instructions\n",
    );
    const blob = await archive.generateAsync({ type: "blob" });
    const file = new File([blob], "release-notes.skill", { type: "application/zip" });

    const { container } = render(
      <SettingsPage
        coworkers={[]}
        dataPath="/tmp/coworker-data"
        integrations={[]}
        onChanged={onChanged}
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

    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    fireEvent.change(input!, { target: { files: [file] } });

    await waitFor(() => expect(installFromPackage).toHaveBeenCalledOnce());
    expect(installFromPackage.mock.calls[0]?.[0]).toBe("release-notes.skill");
    expect(installFromPackage.mock.calls[0]?.[1]).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(onChanged).toHaveBeenCalledOnce();
    expect(screen.getByRole("status").textContent).toContain("release-notes was installed");
  });
});
