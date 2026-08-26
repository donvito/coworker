// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuickModelSwitcher } from "@renderer/components/QuickModelSwitcher";
import type { Coworker } from "@shared/contracts";

const coworker: Coworker = {
  id: "coworker-1",
  name: "Ava",
  role: "Accounting",
  description: null,
  systemPrompt: "Work carefully.",
  modelProvider: "openrouter",
  modelName: "vendor/old-model",
  status: "active",
  runtimeStatus: "IDLE",
  workspacePath: "/tmp/ava",
  enabledTools: [],
  enabledSkillIds: [],
  policies: {},
  sharedFolders: [],
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
};

afterEach(() => cleanup());

function credentialStatus(...providers: string[]) {
  return vi.fn(async (key: string) => ({
    configured: providers.some((provider) => key === `model:${provider}`),
  }));
}

describe("quick coworker model switcher", () => {
  it("filters a large catalog in a bounded searchable picker", async () => {
    const models = Array.from({ length: 20 }, (_, index) => ({
      id: `vendor/model-${index + 1}`,
      name: `Model ${index + 1}`,
      supportsImages: index === 18,
      pricing: {
        currency: "USD" as const,
        inputPerMillion: index === 18 ? 0.5 : 1,
        outputPerMillion: index === 18 ? 1.5 : 2,
      },
    }));
    Object.defineProperty(window, "coworker", {
      configurable: true,
      value: {
        integrations: {
          credentialStatus: credentialStatus("openrouter"),
          listModels: vi.fn().mockResolvedValue(models),
        },
        coworkers: { update: vi.fn() },
      },
    });

    render(
      <QuickModelSwitcher
        coworker={{ ...coworker, modelName: "vendor/model-1" }}
        onChanged={vi.fn()}
      />,
    );
    const selector = await screen.findByRole("combobox", { name: "Model used by Ava" });
    await waitFor(() => expect((selector as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(selector);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search models for Ava" }), {
      target: { value: "model-19" },
    });

    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toContain("Model 19");
    expect(options[0]?.textContent).toContain("vendor/model-19");
    expect(options[0]?.textContent).toContain("$0.50/M input · $1.50/M output");
    expect(screen.getByText("1 of 20")).toBeTruthy();
  });

  it("persists a header selection immediately and refreshes app state", async () => {
    const update = vi.fn().mockResolvedValue({ ...coworker, modelName: "vendor/new-model" });
    const onChanged = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "coworker", {
      configurable: true,
      value: {
        integrations: {
          credentialStatus: credentialStatus("openrouter"),
          listModels: vi.fn().mockResolvedValue([
            { id: "vendor/old-model", name: "Old model", supportsImages: false },
            { id: "vendor/new-model", name: "New model", supportsImages: true },
          ]),
        },
        coworkers: { update },
      },
    });

    render(<QuickModelSwitcher coworker={coworker} onChanged={onChanged} />);
    const selector = await screen.findByRole("combobox", { name: "Model used by Ava" });
    await waitFor(() => expect((selector as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(selector);
    fireEvent.click(screen.getByRole("option", { name: /New model/ }));

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith("coworker-1", {
        modelProvider: "openrouter",
        modelName: "vendor/new-model",
      });
      expect(onChanged).toHaveBeenCalledOnce();
      expect(screen.getByText(/^OpenRouter/)).toBeTruthy();
    });
  });

  it("keeps showing the selected model's pricing after the coworker refreshes", async () => {
    const pricedModels = [
      {
        id: "vendor/old-model",
        name: "Old model",
        supportsImages: false,
        pricing: { currency: "USD" as const, inputPerMillion: 0.375, outputPerMillion: 1.88 },
      },
      {
        id: "vendor/new-model",
        name: "New model",
        supportsImages: false,
        pricing: { currency: "USD" as const, inputPerMillion: 1, outputPerMillion: 2 },
      },
    ];
    Object.defineProperty(window, "coworker", {
      configurable: true,
      value: {
        integrations: {
          credentialStatus: credentialStatus("openrouter"),
          listModels: vi.fn().mockResolvedValue(pricedModels),
        },
        coworkers: {
          update: vi.fn().mockResolvedValue({ ...coworker, modelName: "vendor/new-model" }),
        },
      },
    });

    const view = render(<QuickModelSwitcher coworker={coworker} onChanged={vi.fn()} />);
    await screen.findByText("$0.375/M input · $1.88/M output");

    const selector = screen.getByRole("combobox", { name: "Model used by Ava" });
    await waitFor(() => expect((selector as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(selector);
    fireEvent.click(screen.getByRole("option", { name: /New model/ }));

    // Parent refreshes the coworker prop after the save lands.
    view.rerender(
      <QuickModelSwitcher
        coworker={{ ...coworker, modelName: "vendor/new-model" }}
        onChanged={vi.fn()}
      />,
    );
    await screen.findByText("$1.00/M input · $2.00/M output");
  });

  it("restores the previous selection when persistence fails", async () => {
    Object.defineProperty(window, "coworker", {
      configurable: true,
      value: {
        integrations: {
          credentialStatus: credentialStatus("openrouter"),
          listModels: vi.fn().mockResolvedValue([
            { id: "vendor/old-model", name: "Old model", supportsImages: false },
            { id: "vendor/new-model", name: "New model", supportsImages: true },
          ]),
        },
        coworkers: { update: vi.fn().mockRejectedValue(new Error("Database unavailable")) },
      },
    });

    render(<QuickModelSwitcher coworker={coworker} onChanged={vi.fn()} />);
    const selector = await screen.findByRole("combobox", { name: "Model used by Ava" });
    await waitFor(() => expect((selector as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(selector);
    fireEvent.click(screen.getByRole("option", { name: /New model/ }));

    await waitFor(() => {
      expect(selector.textContent).toContain("Old model");
      expect(screen.getByRole("alert").textContent).toContain("Not saved");
    });
  });

  it("switches between configured providers without opening Settings", async () => {
    const update = vi.fn().mockResolvedValue({
      ...coworker,
      modelProvider: "openai",
      modelName: "gpt-new",
    });
    Object.defineProperty(window, "coworker", {
      configurable: true,
      value: {
        integrations: {
          credentialStatus: credentialStatus("openrouter", "openai"),
          listModels: vi.fn(async (provider: string) =>
            provider === "openai"
              ? [{ id: "gpt-new", name: "GPT New", supportsImages: true }]
              : [{ id: "vendor/old-model", name: "Old model", supportsImages: false }],
          ),
        },
        coworkers: { update },
      },
    });

    render(<QuickModelSwitcher coworker={coworker} onChanged={vi.fn()} />);
    const selector = await screen.findByRole("combobox", { name: "Model used by Ava" });
    await waitFor(() => expect((selector as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(selector);
    fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: "OpenAI" }));
    fireEvent.click(await screen.findByRole("option", { name: /GPT New/ }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("coworker-1", {
        modelProvider: "openai",
        modelName: "gpt-new",
      }),
    );
  });
});
