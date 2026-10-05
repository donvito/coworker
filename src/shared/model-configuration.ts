import type { Coworker } from "./contracts";

export const modelNotConfiguredMessage = "No model configured. Choose a provider and model to continue.";

export function hasConfiguredModel(coworker: Pick<Coworker, "modelProvider" | "modelName">): boolean {
  return coworker.modelProvider !== "demo" && Boolean(coworker.modelName.trim());
}
