// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("explains how to set a default when no provider is connected", async () => {
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
    // With no global default yet the switch starts on so the first verified
    // provider becomes the default in the same save.
    const defaultSwitch = screen.getByRole("checkbox");
    expect((defaultSwitch as HTMLInputElement).checked).toBe(true);
    await screen.findByText(/The model list loads once the connection is verified/);
    expect(screen.getByText(/No global default model configured yet/)).toBeTruthy();
  });

  it("changes the global default model inside the provider's credential form", async () => {
    const configureModel = vi.fn().mockResolvedValue({
      key: "model:openrouter",
      configured: true,
      models: [
        { id: "vendor/old-model", name: "Old model", supportsImages: false },
        { id: "vendor/new-model", name: "New model", supportsImages: true },
      ],
      defaultApplied: true,
    });
    const onChanged = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "coworker", {
      configurable: true,
      value: {
        integrations: {
          credentialStatus: vi.fn(async (key: string) => ({
            configured: key === "model:openrouter" || key === "model:openai",
          })),
          listModels: vi.fn().mockResolvedValue([
            { id: "vendor/old-model", name: "Old model", supportsImages: false },
            { id: "vendor/new-model", name: "New model", supportsImages: true },
          ]),
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
    const openRouter = await screen.findByRole("button", {
      name: "OpenRouter Connected · Default",
    });
    fireEvent.click(openRouter);

    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    const model = screen.getByRole("combobox", { name: "Model" });
    await waitFor(() => expect((model as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(model);
    fireEvent.click(screen.getByRole("option", { name: /New model/ }));

    fireEvent.click(screen.getByRole("button", { name: "Verify and save" }));
    await waitFor(() =>
      expect(configureModel).toHaveBeenCalledWith({
        provider: "openrouter",
        apiKey: undefined,
        baseUrl: undefined,
        defaultModelName: "vendor/new-model",
      }),
    );
    expect(onChanged).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "vendor/new-model is now the global default model",
      ),
    );
  });

  it("connects a new provider and applies its first model as the default in one save", async () => {
    const configureModel = vi.fn().mockResolvedValue({
      key: "model:openrouter",
      configured: true,
      models: [{ id: "vendor/first-model", name: "First model", supportsImages: false }],
      defaultApplied: false,
    });
    const updateSettings = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "coworker", {
      configurable: true,
      value: {
        app: { updateSettings },
        integrations: {
          credentialStatus: vi.fn().mockResolvedValue({ configured: false }),
          listModels: vi.fn().mockResolvedValue([
            { id: "vendor/first-model", name: "First model", supportsImages: false },
          ]),
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
        defaultModelName: undefined,
      }),
    );
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        defaultModelProvider: "openrouter",
        defaultModelName: "vendor/first-model",
      }),
    );
    expect(screen.getByRole("status").textContent).toContain(
      "vendor/first-model is now the global default model",
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
