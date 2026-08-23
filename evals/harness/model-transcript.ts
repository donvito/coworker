import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RemoteModelProvider } from "@shared/contracts";

/**
 * Behavior evals assert model judgment, so they are recorded once against a
 * real provider and replayed afterwards. Recordings are committed: CI replays
 * real model decisions without needing a key or spending anything per run.
 */
export const recordingsDir = resolve("evals/recordings");

const supportedLiveProviders = new Set<RemoteModelProvider>([
  "anthropic",
  "openai",
  "google",
  "openrouter",
]);

export interface LiveModelConfig {
  provider: RemoteModelProvider;
  id: string;
  apiKey: string;
}

function apiKeyForProvider(provider: RemoteModelProvider | undefined): string | undefined {
  if (process.env.EVAL_API_KEY) return process.env.EVAL_API_KEY;
  switch (provider) {
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY;
    case "openai":
      return process.env.OPENAI_API_KEY;
    case "google":
      return process.env.GOOGLE_API_KEY;
    case "openrouter":
      return process.env.OPENROUTER_API_KEY;
    default:
      return undefined;
  }
}

/** The live provider to record against, or null when none is configured. */
export function liveModel(): LiveModelConfig | null {
  const provider = process.env.EVAL_PROVIDER as RemoteModelProvider | undefined;
  const id = process.env.EVAL_MODEL;
  const apiKey = apiKeyForProvider(provider);
  if (!provider || !supportedLiveProviders.has(provider) || !id || !apiKey) return null;
  return { provider, id, apiKey };
}

export function recordingPath(scenarioName: string): string {
  const slug = scenarioName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return join(recordingsDir, `${slug}.json`);
}

export function hasRecording(scenarioName: string): boolean {
  return existsSync(recordingPath(scenarioName));
}
