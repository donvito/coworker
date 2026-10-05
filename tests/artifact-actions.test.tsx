// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ArtifactFileStatus, DesktopEvent } from "@shared/contracts";
import { ArtifactActions } from "@renderer/components/ArtifactActions";

afterEach(cleanup);

function setup(initial: ArtifactFileStatus = "available") {
  const listeners = new Set<(event: DesktopEvent) => void>();
  const status = vi.fn().mockResolvedValue(initial);
  const open = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, "coworker", { configurable: true, value: {
    artifacts: { status, open },
    events: { subscribe: (listener: (event: DesktopEvent) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    } },
  } });
  return { status, open, changed: () => listeners.forEach(listener => listener({ type: "entity.changed", entity: "artifacts" })) };
}

it("updates historical tool-result actions after explorer deletion and after remount", async () => {
  const api = setup();
  const target = { id: "old-artifact", name: "report.pdf" };
  const view = render(<ArtifactActions target={target} />);
  await waitFor(() => expect((screen.getByRole("button", { name: "Open report.pdf" }) as HTMLButtonElement).disabled).toBe(false));
  api.status.mockResolvedValue("deleted");
  api.changed();
  await screen.findByText("Deleted");
  expect(screen.queryByRole("button")).toBeNull();
  view.unmount();
  render(<ArtifactActions target={target} />);
  await screen.findByText("Deleted");
  expect(screen.queryByRole("button")).toBeNull();
});

it("detects external deletion and restoration when returning to the app", async () => {
  const api = setup("missing");
  render(<ArtifactActions target={{ id: "artifact", name: "report.pdf" }} />);
  await screen.findByText("File missing");
  expect(screen.queryByRole("button")).toBeNull();
  api.status.mockResolvedValue("available");
  fireEvent(window, new Event("focus"));
  fireEvent.click(await screen.findByRole("button", { name: "Open report.pdf" }));
  await waitFor(() => expect(api.open).toHaveBeenCalledWith("artifact"));
  api.status.mockResolvedValue("missing");
  fireEvent(window, new Event("focus"));
  await screen.findByText("File missing");
});

it("does not let a stale availability check restore deleted-file buttons", async () => {
  const api = setup();
  let finish!: (value: ArtifactFileStatus) => void;
  api.status.mockImplementationOnce(() => new Promise<ArtifactFileStatus>(resolve => { finish = resolve; }));
  render(<ArtifactActions target={{ id: "artifact", name: "report.pdf" }} />);
  api.status.mockResolvedValue("deleted");
  api.changed();
  await screen.findByText("Deleted");
  finish("available");
  await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
});

it("shows unavailable rather than deleted on an access or IPC failure", async () => {
  const api = setup();
  api.status.mockRejectedValue(new Error("Permission denied"));
  render(<ArtifactActions target={{ id: "artifact", name: "report.pdf" }} />);
  await screen.findByText("File unavailable");
  expect(screen.queryByText("Deleted")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
});
