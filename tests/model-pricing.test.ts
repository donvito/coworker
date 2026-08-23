import { describe, expect, it } from "vitest";
import { modelOptionLabel, modelPricingLabel } from "@renderer/lib/model-pricing";

describe("model pricing labels", () => {
  it("formats OpenRouter rates per million tokens", () => {
    expect(
      modelOptionLabel({
        id: "vendor/paid",
        name: "Paid model",
        supportsImages: true,
        pricing: {
          currency: "USD",
          inputPerMillion: 0.25,
          outputPerMillion: 1.75,
          request: 0,
        },
      }),
    ).toBe("Paid model — vendor/paid · image input · $0.25/M input · $1.75/M output");
  });

  it("identifies a zero-priced model as free", () => {
    expect(
      modelPricingLabel({
        pricing: {
          currency: "USD",
          inputPerMillion: 0,
          outputPerMillion: 0,
          request: 0,
        },
      }),
    ).toBe("Free");
  });

  it("formats high catalog rates without invalid fraction settings", () => {
    expect(
      modelPricingLabel({
        pricing: { currency: "USD", inputPerMillion: 150, outputPerMillion: 300 },
      }),
    ).toBe("$150/M input · $300/M output");
  });
});
