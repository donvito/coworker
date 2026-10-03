// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatGPTAuthStatus } from "@shared/chatgpt-auth";
import type { Coworker, DesktopEvent } from "@shared/contracts";
import { QuickModelSwitcher } from "@renderer/components/QuickModelSwitcher";
import { ChatGPTPlanIndicator, ChatGPTWelcomeDialog } from "@renderer/components/ChatGPTPlanIndicator";
import { SettingsPage } from "@renderer/pages/SettingsPage";

afterEach(() => cleanup());

const disconnectedStatus: ChatGPTAuthStatus = {
  mode: "api-key",
  state: "disconnected",
  activeAccountId: null,
  accounts: [],
  welcomeSeen: true,
};

function connectedStatus(overrides: Partial<ChatGPTAuthStatus> = {}): ChatGPTAuthStatus {
  return {
    mode: "chatgpt-subscription",
    state: "connected",
    activeAccountId: "account-a",
    accounts: [
      {
        id: "account-a",
        label: "Personal account",
        email: "same@example.com",
        connected: true,
        planUsageEnabled: true,
      },
      {
        id: "account-b",
        label: "Work account",
        email: "same@example.com",
        connected: true,
        planUsageEnabled: true,
      },
    ],
    welcomeSeen: true,
    ...overrides,
  };
}

function setup(status: ChatGPTAuthStatus, credentialConfigured = false) {
  let currentStatus = status;
  let eventListener: ((event: DesktopEvent) => void) | undefined;
  let finishSignIn: ((status: ChatGPTAuthStatus) => void) | undefined;
  const integrations = {
    credentialStatus: vi.fn(async (key: string) => ({
      key,
      configured: key === "model:openai" && credentialConfigured,
      needsReentry: false,
    })),
    listModels: vi.fn().mockResolvedValue([
      { id: "gpt-test", name: "GPT test", supportsImages: false },
    ]),
    configureModel: vi.fn().mockResolvedValue({
      key: "model:openai",
      configured: true,
      models: [{ id: "gpt-test", name: "GPT test", supportsImages: false }],
      defaultApplied: true,
    }),
    disconnectModel: vi.fn().mockImplementation(async () => {
      currentStatus = { ...currentStatus, state: "disconnected", activeAccountId: null };
      return { revocationConfirmed: false };
    }),
    chatgptStatus: vi.fn(async () => currentStatus),
    chatgptSignIn: vi.fn(async () =>
      new Promise<ChatGPTAuthStatus>((resolve) => {
        finishSignIn = resolve;
      }),
    ),
    chatgptCancelSignIn: vi.fn(async () => {
      currentStatus = { ...currentStatus, state: "disconnected" };
      finishSignIn?.(currentStatus);
      return currentStatus;
    }),
    setOpenAIAuthMode: vi.fn(async (mode: ChatGPTAuthStatus["mode"]) => {
      currentStatus = {
        ...currentStatus,
        mode,
        state: mode === "chatgpt-subscription" ? currentStatus.state : "disconnected",
      };
      return currentStatus;
    }),
    chatgptSelectAccount: vi.fn(async (accountId: string) => {
      currentStatus = { ...currentStatus, activeAccountId: accountId };
      return currentStatus;
    }),
    chatgptAcknowledgeWelcome: vi.fn(async () => {
      currentStatus = { ...currentStatus, welcomeSeen: true };
      return currentStatus;
    }),
    chatgptManageUsage: vi.fn().mockResolvedValue(undefined),
  };
  Object.defineProperty(window, "coworker", {
    configurable: true,
    value: {
      app: { updateSettings: vi.fn().mockResolvedValue(undefined) },
      integrations,
      diagnostics: { listProviderErrors: vi.fn().mockResolvedValue([]) },
      events: {
        subscribe: vi.fn((listener: (event: DesktopEvent) => void) => {
          eventListener = listener;
          return () => {
            eventListener = undefined;
          };
        }),
      },
    },
  });

  const onChanged = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <SettingsPage
      coworkers={[]}
      dataPath="/tmp/coworker-data"
      initialTab="models"
      integrations={[]}
      onChanged={onChanged}
      settings={{
        demoMode: false,
        launchAtLogin: false,
        runInBackground: true,
        theme: "forest",
        colorMode: "light",
        showReasoning: true,
        globalOperatingInstructions: "",
        defaultModelProvider: null,
        defaultModelName: null,
      }}
      skills={[]}
    />,
  );
  return {
    currentStatus: () => currentStatus,
    setStatus: (next: ChatGPTAuthStatus) => {
      currentStatus = next;
    },
    emitDesktopEvent: (event: DesktopEvent) => eventListener?.(event),
    finishSignIn: () => finishSignIn,
    integrations,
    onChanged,
    ...view,
  };
}

async function selectOpenAIProvider() {
  fireEvent.click(await screen.findByRole("button", { name: /^OpenAI/ }));
}

describe("ChatGPT plan settings", () => {
  it("lets the user select a plan without asking for an API key", async () => {
    const app = setup(disconnectedStatus, true);
    await selectOpenAIProvider();
    const planMethod = await screen.findByRole("radio", { name: /ChatGPT subscription/i });

    fireEvent.click(planMethod);
    await waitFor(() =>
      expect(app.integrations.setOpenAIAuthMode).toHaveBeenCalledWith("chatgpt-subscription"),
    );
    expect(await screen.findByRole("button", { name: /Continue with ChatGPT/i })).toBeTruthy();
    expect(screen.queryByLabelText("OpenAI API key")).toBeNull();
  });

  it("shows the waiting state and cancels a pending sign-in", async () => {
    const app = setup(disconnectedStatus);
    await selectOpenAIProvider();
    fireEvent.click(await screen.findByRole("radio", { name: /ChatGPT subscription/i }));
    await waitFor(() => expect(app.integrations.setOpenAIAuthMode).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: /Continue with ChatGPT/i }));

    expect(await screen.findByText("Waiting for ChatGPT sign-in…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(app.integrations.chatgptCancelSignIn).toHaveBeenCalledOnce());
    expect(screen.queryByText("Waiting for ChatGPT sign-in…")).toBeNull();
  });

  it("switches retained accounts and keeps same-email labels distinct", async () => {
    const app = setup(connectedStatus());
    await selectOpenAIProvider();
    const accountSelect = await screen.findByRole("combobox", { name: "ChatGPT account" });
    const optionLabels = Array.from((accountSelect as HTMLSelectElement).options).map(
      (option) => option.textContent,
    );
    expect(optionLabels).toContain("Personal account · same@example.com");
    expect(optionLabels).toContain("Work account · same@example.com");

    fireEvent.change(accountSelect, { target: { value: "account-b" } });
    await waitFor(() =>
      expect(app.integrations.chatgptSelectAccount).toHaveBeenCalledWith("account-b"),
    );
    expect((accountSelect as HTMLSelectElement).value).toBe("account-b");
    expect(app.container.querySelector(".chatgpt-account-connected")?.textContent).toContain(
      "Connected as Work account",
    );
  });

  it("does not repeat an email already included in a saved account label", async () => {
    const status = connectedStatus({
      activeAccountId: "workspace-one",
      accounts: [
        {
          id: "workspace-one",
          label: "person@example.com · Workspace 1",
          email: "person@example.com",
          connected: true,
          planUsageEnabled: true,
        },
        {
          id: "workspace-two",
          label: "person@example.com · Workspace 2",
          email: "person@example.com",
          connected: true,
          planUsageEnabled: true,
        },
      ],
    });
    const app = setup(status);
    await selectOpenAIProvider();
    const accountSelect = await screen.findByRole("combobox", { name: "ChatGPT account" });
    expect(Array.from((accountSelect as HTMLSelectElement).options).map((item) => item.textContent))
      .toContain("person@example.com · Workspace 1");
    expect(app.container.querySelector(".chatgpt-account-connected")?.textContent).toContain(
      "Connected as person@example.com · Workspace 1.",
    );
  });

  it("reauthorizes a retained disconnected account using its saved registration", async () => {
    const status = connectedStatus({
      activeAccountId: "account-b",
      accounts: [
        {
          id: "account-a",
          label: "Personal account",
          email: "same@example.com",
          connected: false,
          planUsageEnabled: false,
        },
        {
          id: "account-b",
          label: "Work account",
          email: "same@example.com",
          connected: true,
          planUsageEnabled: false,
        },
      ],
    });
    const app = setup(status);
    await selectOpenAIProvider();
    const accountSelect = await screen.findByRole("combobox", { name: "ChatGPT account" });
    expect(Array.from((accountSelect as HTMLSelectElement).options).map((item) => item.textContent))
      .toContain("Personal account · same@example.com · Reconnect");

    fireEvent.change(accountSelect, { target: { value: "account-a" } });
    await waitFor(() =>
      expect(app.integrations.chatgptSignIn).toHaveBeenCalledWith("account-a"),
    );
    expect(app.integrations.chatgptSelectAccount).not.toHaveBeenCalled();
  });

  it("continues with the only retained account instead of starting a duplicate registration", async () => {
    const savedAccountStatus = connectedStatus({
      state: "disconnected",
      activeAccountId: null,
      accounts: [
        {
          id: "saved-account",
          label: "Personal account",
          email: "person@example.com",
          connected: false,
          planUsageEnabled: false,
        },
      ],
    });
    const app = setup(savedAccountStatus);
    await selectOpenAIProvider();

    await waitFor(() =>
      expect(app.container.querySelector(".chatgpt-account-permission")?.textContent).toContain(
        "Saved account Personal account · person@example.com needs to reconnect",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /Continue with ChatGPT/i }));
    await waitFor(() =>
      expect(app.integrations.chatgptSignIn).toHaveBeenCalledWith("saved-account"),
    );
  });

  it("reports missing plan access and presents a safe sign-in error", async () => {
    const noPlanAccess = connectedStatus({
      accounts: [
        {
          id: "account-a",
          label: "Personal account",
          email: "person@example.com",
          connected: true,
          planUsageEnabled: false,
        },
      ],
    });
    const app = setup(noPlanAccess);
    await selectOpenAIProvider();
    expect(await screen.findByText(/can’t use its plan with Coworker/)).toBeTruthy();
    app.integrations.chatgptSignIn.mockRejectedValueOnce(new Error("raw callback details"));
    fireEvent.click(screen.getByRole("button", { name: /Continue with ChatGPT/i }));

    expect(await screen.findByText(/couldn’t finish signing in to ChatGPT/i)).toBeTruthy();
    expect(screen.queryByText("raw callback details")).toBeNull();
  });

  it("keeps a saved API key inactive in subscription mode and confirms disconnect", async () => {
    const app = setup(connectedStatus(), true);
    await selectOpenAIProvider();
    expect(await screen.findByRole("button", { name: /OpenAI ChatGPT plan connected/i })).toBeTruthy();
    expect(screen.queryByLabelText("OpenAI API key")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    const dialog = screen.getByRole("alertdialog", { name: "Disconnect OpenAI?" });
    expect(dialog.textContent).toContain("This ChatGPT account will be disconnected");
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await screen.findByText(/ChatGPT was disconnected on this computer, but sign-out could not be confirmed/i);
    expect(app.integrations.disconnectModel).toHaveBeenCalledWith("openai");

    fireEvent.click(screen.getByRole("radio", { name: /OpenAI API key/i }));
    await waitFor(() => expect(app.integrations.setOpenAIAuthMode).toHaveBeenCalledWith("api-key"));
    expect(await screen.findByText("API key saved")).toBeTruthy();
  });

  it("keeps disconnect available for a revoked active ChatGPT account", async () => {
    const revokedStatus = connectedStatus({
      state: "sign-in-required",
      activeAccountId: "revoked-account",
      accounts: [
        {
          id: "revoked-account",
          label: "Personal account",
          email: "person@example.com",
          connected: false,
          planUsageEnabled: false,
        },
      ],
    });
    const app = setup(revokedStatus);
    await selectOpenAIProvider();

    await waitFor(() =>
      expect(app.container.querySelector(".chatgpt-account-permission")?.textContent).toContain(
        "Sign in to Personal account · person@example.com again",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    const dialog = screen.getByRole("alertdialog", { name: "Disconnect OpenAI?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(app.integrations.disconnectModel).toHaveBeenCalledWith("openai"));
  });

  it("acknowledges the first plan welcome only after dismissal", async () => {
    const app = setup(connectedStatus({ welcomeSeen: false }));
    await selectOpenAIProvider();
    expect(await screen.findByRole("dialog", { name: "You’re using your ChatGPT plan" })).toBeTruthy();
    expect(app.integrations.chatgptAcknowledgeWelcome).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    await waitFor(() =>
      expect(app.integrations.chatgptAcknowledgeWelcome).toHaveBeenCalledOnce(),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("traps welcome-dialog focus and restores the previous focus after dismissal", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Open settings";
    document.body.append(opener);
    opener.focus();

    const acknowledge = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <ChatGPTWelcomeDialog
        onAcknowledge={acknowledge}
        status={connectedStatus({ welcomeSeen: false })}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: "You’re using your ChatGPT plan" });
    const gotIt = within(dialog).getByRole("button", { name: "Got it" });
    expect(document.activeElement).toBe(gotIt);

    fireEvent.keyDown(gotIt, { key: "Tab" });
    expect(document.activeElement).toBe(gotIt);
    opener.focus();
    fireEvent.keyDown(opener, { key: "Tab" });
    expect(document.activeElement).toBe(gotIt);

    fireEvent.keyDown(gotIt, { key: "Escape" });
    await waitFor(() => expect(acknowledge).toHaveBeenCalledOnce());
    view.rerender(
      <ChatGPTWelcomeDialog
        onAcknowledge={acknowledge}
        status={connectedStatus({ welcomeSeen: true })}
      />,
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("opens ChatGPT usage from the composer indicator", async () => {
    const app = setup(connectedStatus());
    render(
      <ChatGPTPlanIndicator status={app.currentStatus()} usageLimitReached />,
    );
    expect(screen.getByText(/Usage limit reached/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Manage usage" }));
    await waitFor(() => expect(app.integrations.chatgptManageUsage).toHaveBeenCalledOnce());
  });

  it("refreshes account status on auth events and runtime failure without reloading unrelated catalogs", async () => {
    const initial = connectedStatus();
    const app = setup(initial, true);
    const coworker: Coworker = {
      id: "coworker-1",
      name: "Ava",
      role: "Accounting",
      description: null,
      systemPrompt: "Work carefully.",
      modelProvider: "openai",
      modelName: "gpt-test",
      status: "active",
      runtimeStatus: "IDLE",
      workspacePath: "/tmp/ava",
      enabledTools: [],
      enabledSkillIds: [],
      isPrimary: false,
      tags: [],
      policies: {},
      sharedFolders: [],
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
    };
    const listModels = app.integrations.listModels;
    render(
      <QuickModelSwitcher
        chip
        coworker={coworker}
        onChanged={app.onChanged}
        showPlanUsage
      />,
    );
    await screen.findByText("Using ChatGPT plan");
    await waitFor(() => expect(listModels).toHaveBeenCalledWith("openai"));
    expect(listModels).toHaveBeenCalledOnce();
    const initialStatusReads = app.integrations.chatgptStatus.mock.calls.length;

    act(() =>
      app.emitDesktopEvent({
        type: "runtime.status",
        coworkerId: coworker.id,
        status: "ERROR",
      }),
    );
    await waitFor(() =>
      expect(app.integrations.chatgptStatus).toHaveBeenCalledTimes(initialStatusReads + 1),
    );
    expect(screen.getByText("Using ChatGPT plan")).toBeTruthy();
    expect(listModels).toHaveBeenCalledOnce();

    app.setStatus({ ...initial, state: "sign-in-required" });
    act(() =>
      app.emitDesktopEvent({ type: "entity.changed", entity: "integrations" }),
    );
    await waitFor(() =>
      expect(app.integrations.chatgptStatus).toHaveBeenCalledTimes(initialStatusReads + 2),
    );
    expect(screen.queryByText("Using ChatGPT plan")).toBeNull();
    expect(listModels).toHaveBeenCalledOnce();
    expect((screen.getByRole("combobox", { name: "Model used by Ava" }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it("refreshes an open Settings account summary when authentication changes", async () => {
    const app = setup(connectedStatus());
    await selectOpenAIProvider();
    await waitFor(() =>
      expect(app.container.querySelector(".chatgpt-account-connected")?.textContent).toContain(
        "Connected as",
      ),
    );

    app.setStatus({ ...app.currentStatus(), state: "sign-in-required" });
    act(() =>
      app.emitDesktopEvent({ type: "entity.changed", entity: "integrations" }),
    );

    await waitFor(() =>
      expect(app.container.querySelector(".chatgpt-account-permission")?.textContent).toContain(
        "Sign in to Personal account · same@example.com again",
      ),
    );
    expect(screen.getByRole("button", { name: /OpenAI Sign-in required/i })).toBeTruthy();
  });
});
