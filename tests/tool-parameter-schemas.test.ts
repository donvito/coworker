import { describe, expect, it } from "vitest";
import { parameterSchemas } from "@main/runtime/tool-parameter-schemas";
import { attachImagesToolName, maxMessageImages } from "@shared/message-images";

describe("model-facing tool parameters", () => {
  it("lets the model attach as many images as the gateway accepts", () => {
    const images = (parameterSchemas[attachImagesToolName]?.properties as Record<string, { minItems?: number; maxItems?: number }>)
      .images;
    expect(maxMessageImages).toBe(20);
    expect(images).toMatchObject({ minItems: 1, maxItems: maxMessageImages });
  });
});
