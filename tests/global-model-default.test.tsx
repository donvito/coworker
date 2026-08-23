// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateCoworkerModal } from "@renderer/pages/CoworkersPage";
import { SettingsPage } from "@renderer/pages/SettingsPage";

afterEach(() => cleanup());

describe("global model default", () => {
  it("shows and saves editable global operating instructions", async () => {
    const updateSettings = vi.fn().mockResolvedValue(undefined);
    const onChanged = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "coworker", {
      configurable: true,
      value: {
        app: { updateSettings },
        integrations: {
          credentialStatus: vi.fn().mockResolvedValue({ configured: false }),
        },
        diagnostics: {
          listProviderErrors: vi.fn().mockResolvedValue([]),
        },
      },
    });

    render(
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

    const instructions = screen.getByRole("textbox", {
      name: "Global operating instructions",
    });
    expect((instructions as HTMLTextAreaElement).value).toBe(
      "Ask when information is missing.",
    );
    fireEvent.change(instructions, {
      target: { value: "Ask a concise follow-up before making assumptions." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save instructions" }));

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        globalOperatingInstructions: "Ask a concise follow-up before making assumptions.",
      }),
    );
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("shows no configured model when no provider credentials have been saved", async () => {
    Object.defineProperty(window, "coworker", {
      configurable: true,
      value: {
        integrations: {
          credentialStatus: vi.fn().mockResolvedValue({ configured: false }),
        },
        diagnostics: {
          listProviderErrors: vi.fn().mockResolvedValue([]),
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
      theme: "forest",
      showReasoning: true,
      globalOperatingInstructions: "Ask when information is missing.",
      defaultModelProvider: null,
          defaultModelName: null,
        }}
        skills={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Models" }));
    const browser = (await screen.findByText("Default model")).closest(
      ".settings-model-browser",
    );
    expect(browser).not.toBeNull();
    const provider = within(browser as HTMLElement).getByRole("combobox", {
      name: "Provider",
    });
    await waitFor(() => expect((provider as HTMLSelectElement).disabled).toBe(true));
    expect(within(provider).getByRole("option", { name: "No model configured" })).toBeTruthy();
    expect(within(browser as HTMLElement).queryByText("Built-in demo")).toBeNull();
  });

  it("lists connected providers and saves a selected catalog model as the default", async () => {
    const updateSettings = vi.fn().mockResolvedValue(undefined);
    const onChanged = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "coworker", {
      configurable: true,
      value: {
        app: { updateSettings },
        integrations: {
          credentialStatus: vi.fn(async (key: string) => ({
            configured: key === "model:openrouter" || key === "model:openai",
          })),
          listModels: vi.fn().mockResolvedValue([
            {
              id: "vendor/old-model",
              name: "Old model",
              supportsImages: false,
              pricing: { currency: "USD", inputPerMillion: 1, outputPerMillion: 2 },
            },
            {
              id: "vendor/new-model",
              name: "New model",
              supportsImages: true,
              pricing: { currency: "USD", inputPerMillion: 0.5, outputPerMillion: 1.5 },
            },
          ]),
        },
        diagnostics: {
          listProviderErrors: vi.fn().mockResolvedValue([]),
        },
      },
    });

    render(
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
      defaultModelProvider: "openrouter",
          defaultModelName: "vendor/old-model",
        }}
        skills={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Models" }));
    const browser = (await screen.findByText("Default model")).closest(
      ".settings-model-browser",
    );
    expect(browser).not.toBeNull();
    const provider = within(browser as HTMLElement).getByRole("combobox", {
      name: "Provider",
    });
    await waitFor(() => expect((provider as HTMLSelectElement).disabled).toBe(false));
    expect(within(provider).queryByRole("option", { name: "Built-in demo" })).toBeNull();
    expect(within(provider).getByRole("option", { name: "OpenAI" })).toBeTruthy();
    expect(within(provider).getByRole("option", { name: "OpenRouter" })).toBeTruthy();
    expect(within(provider).queryByRole("option", { name: "Anthropic" })).toBeNull();

    const model = within(browser as HTMLElement).getByRole("combobox", { name: "Model" });
    await waitFor(() => expect((model as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(model);
    fireEvent.click(
      within(browser as HTMLElement).getByRole("option", { name: /New model/ }),
    );

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        defaultModelProvider: "openrouter",
        defaultModelName: "vendor/new-model",
      }),
    );
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("selects a credential provider from its card without a redundant dropdown", async () => {
    const configureModel = vi.fn().mockResolvedValue({ key: "model:openrouter" });
    Object.defineProperty(window, "coworker", {
      configurable: true,
      value: {
        integrations: {
          credentialStatus: vi.fn().mockResolvedValue({ configured: false }),
          configureModel,
        },
        diagnostics: {
          listProviderErrors: vi.fn().mockResolvedValue([]),
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
          theme: "forest",
          showReasoning: true,
          globalOperatingInstructions: "Ask when information is missing.",
          defaultModelProvider: null,
          defaultModelName: null,
        }}
        skills={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Models" }));
    const openRouter = screen.getByRole("button", { name: "OpenRouter Not connected" });
    expect(openRouter.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("combobox", { name: "Model provider" })).toBeNull();

    fireEvent.click(openRouter);
    expect(openRouter.getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(screen.getByLabelText("OpenRouter API key"), {
      target: { value: "router-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify and save" }));

    await waitFor(() =>
      expect(configureModel).toHaveBeenCalledWith({
        provider: "openrouter",
        apiKey: "router-key",
        baseUrl: undefined,
      }),
    );
  });

  it("starts a new coworker with the saved global model unless the form is changed", async () => {
    const create = vi.fn().mockResolvedValue({ id: "coworker-1" });
    Object.defineProperty(window, "coworker", {
      configurable: true,
      value: {
        integrations: {
          listModels: vi.fn().mockResolvedValue([
            { id: "vendor/default-model", name: "Default model", supportsImages: false },
          ]),
        },
        coworkers: { create },
      },
    });

    render(
      <CreateCoworkerModal
        settings={{
          defaultModelProvider: "openrouter",
          defaultModelName: "vendor/default-model",
        }}
        onChanged={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Mia" } });
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "Analyst" } });
    await waitFor(() =>
      expect((screen.getByRole("combobox", { name: "Model" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create coworker" }));

    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      modelProvider: "openrouter",
      modelName: "vendor/default-model",
    });
  });
});
