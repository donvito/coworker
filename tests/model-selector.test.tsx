// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelSelector } from "@renderer/components/ModelSelector";

describe("model selector search", () => {
  it("filters a large OpenRouter catalog by model name or ID", async () => {
    const models = Array.from({ length: 20 }, (_, index) => ({
      id: `vendor/model-${index + 1}`,
      name: `Model ${index + 1}`,
      supportsImages: index % 2 === 0,
      pricing: {
        currency: "USD" as const,
        inputPerMillion: index === 18 ? 0.5 : 1,
        outputPerMillion: index === 18 ? 1.5 : 2,
        request: 0,
      },
    }));
    Object.defineProperty(window, "coworker", {
      configurable: true,
      value: {
        integrations: {
          listModels: vi.fn().mockResolvedValue(models),
        },
      },
    });

    render(
      <ModelSelector
        onChange={vi.fn()}
        provider="openrouter"
        value="vendor/model-1"
      />,
    );
    const search = await screen.findByRole("searchbox", { name: "Search openrouter models" });
    fireEvent.change(search, { target: { value: "model-19" } });

    await waitFor(() => {
      const options = screen.getAllByRole("option").map((option) => option.textContent);
      expect(options).toEqual([expect.stringContaining("Model 19")]);
      expect(options[0]).toContain("$0.50/M input · $1.50/M output");
    });
    expect(screen.getByText("1 of 20 models match")).toBeTruthy();
  });
});
