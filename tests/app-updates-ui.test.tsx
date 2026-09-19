// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppUpdateStatus } from "@shared/contracts";
import { UpdateBanner } from "@renderer/components/UpdateBanner";
import { UpdateSettings } from "@renderer/components/UpdateSettings";
import type { AppUpdatesController } from "@renderer/state/app-updates";

afterEach(() => cleanup());

function controller(status: Partial<AppUpdateStatus> & { state: AppUpdateStatus["state"] }): AppUpdatesController {
  return {
    status: {
      currentVersion: "0.6.1",
      canInstall: true,
      releaseUrl: "https://github.com/donvito/coworker/releases/latest",
      ...status,
    },
    busy: false,
    check: vi.fn().mockResolvedValue(undefined),
    download: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(undefined),
    openReleasePage: vi.fn().mockResolvedValue(undefined),
  };
}

describe("update banner", () => {
  it("stays hidden while there is nothing to act on", () => {
    for (const state of ["unsupported", "idle", "checking", "up-to-date", "error"] as const) {
      const { container } = render(<UpdateBanner updates={controller({ state })} />);
      expect(container.querySelector(".update-banner")).toBeNull();
      cleanup();
    }
  });

  it("offers a download for installable builds and can be dismissed per version", () => {
    const updates = controller({ state: "available", latestVersion: "0.7.0" });
    const { rerender } = render(<UpdateBanner updates={updates} />);
    expect(screen.getByRole("status").textContent).toContain("Coworker v0.7.0 is available.");
    fireEvent.click(screen.getByRole("button", { name: "Download update" }));
    expect(updates.download).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss update notice" }));
    expect(screen.queryByRole("status")).toBeNull();

    rerender(<UpdateBanner updates={controller({ state: "downloaded", latestVersion: "0.7.0" })} />);
    expect(screen.getByRole("status").textContent).toContain("Coworker v0.7.0 is ready.");
  });

  it("links to the GitHub release when the build cannot install in place", () => {
    const updates = controller({ state: "available", latestVersion: "0.7.0", canInstall: false });
    render(<UpdateBanner updates={updates} />);
    expect(screen.queryByRole("button", { name: "Download update" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View release" }));
    expect(updates.openReleasePage).toHaveBeenCalledTimes(1);
  });

  it("restarts to install a downloaded update", () => {
    const updates = controller({ state: "downloaded", latestVersion: "0.7.0" });
    render(<UpdateBanner updates={updates} />);
    fireEvent.click(screen.getByRole("button", { name: "Restart to update" }));
    expect(updates.install).toHaveBeenCalledTimes(1);
  });
});

describe("update settings", () => {
  it("toggles automatic updates and triggers manual checks", () => {
    const updates = controller({ state: "up-to-date", latestVersion: "0.6.1" });
    const onToggle = vi.fn();
    render(<UpdateSettings autoUpdate disabled={false} onToggleAutoUpdate={onToggle} updates={updates} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onToggle).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(updates.check).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toContain("latest version");
  });

  it("disables checking in development builds and explains why", () => {
    const updates = controller({ state: "unsupported", canInstall: false });
    render(<UpdateSettings autoUpdate disabled={false} onToggleAutoUpdate={vi.fn()} updates={updates} />);
    expect(screen.getByRole("status").textContent).toContain("installed builds");
    expect((screen.getByRole("button", { name: "Check for updates" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "View releases" })).toBeNull();
  });

  it("surfaces download errors and the GitHub fallback", () => {
    const updates = controller({ state: "error", error: "network down" });
    render(<UpdateSettings autoUpdate={false} disabled={false} onToggleAutoUpdate={vi.fn()} updates={updates} />);
    expect(screen.getByRole("status").textContent).toContain("network down");
    fireEvent.click(screen.getByRole("button", { name: "View releases" }));
    expect(updates.openReleasePage).toHaveBeenCalledTimes(1);
  });
});
