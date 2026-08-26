import { appendFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
  modelProviders,
  providerErrorPhases,
  type KnownModelProvider,
  type ModelProvider,
  type ProviderErrorDiagnostic,
  type ProviderErrorPhase,
} from "@shared/contracts";
import { isCustomModelProvider } from "@shared/model-providers";

export interface ProviderErrorContext {
  phase: ProviderErrorPhase;
  provider: ModelProvider;
  model?: string;
  coworkerId?: string;
  taskId?: string;
  runId?: string;
}

export interface ProviderErrorSink {
  log(context: ProviderErrorContext, error: unknown): Promise<void>;
}

const maxLogBytes = 5 * 1024 * 1024;

export function redactProviderDiagnostic(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,"'}]+/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|key)\s*["']?\s*[:=]\s*["']?)[^\s,"'}&]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:key|api_key|token)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|sk-or-v1|or)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/\/Users\/[^/\s]+\//g, "/Users/[USER]/")
    .replace(/\/home\/[^/\s]+\//g, "/home/[USER]/")
    .replace(/C:\\Users\\[^\\\s]+\\/gi, "C:\\Users\\[USER]\\");
}

function diagnosticError(error: unknown): {
  message: string;
  stack?: string;
  code?: string;
  status?: number;
} {
  const source = error instanceof Error ? error : new Error(String(error));
  const withDetails = error as { code?: unknown; status?: unknown } | null;
  const message = redactProviderDiagnostic(source.message).slice(0, 4_000);
  const statusFromMessage = message.match(/^(\d{3})(?::|\s)/)?.[1];
  const statusValue = Number(withDetails?.status ?? statusFromMessage);
  return {
    message,
    stack: source.stack
      ? redactProviderDiagnostic(source.stack).slice(0, 8_000)
      : undefined,
    code:
      typeof withDetails?.code === "string"
        ? redactProviderDiagnostic(withDetails.code).slice(0, 120)
        : undefined,
    status: Number.isInteger(statusValue) && statusValue >= 100 && statusValue <= 599
      ? statusValue
      : undefined,
  };
}

export class ProviderErrorLogger implements ProviderErrorSink {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  log(context: ProviderErrorContext, error: unknown): Promise<void> {
    const record: ProviderErrorDiagnostic = {
      timestamp: new Date().toISOString(),
      level: "error",
      category: "model_provider",
      ...context,
      ...diagnosticError(error),
    };
    this.writeQueue = this.writeQueue
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        await this.rotateIfNeeded();
        await appendFile(this.path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
      })
      .catch((writeError) => {
        // Diagnostics must never make a provider failure worse or crash the runtime.
        console.error("Could not write provider diagnostic log", writeError);
      });
    return this.writeQueue;
  }

  async list(limit = 100): Promise<ProviderErrorDiagnostic[]> {
    await this.writeQueue;
    const paths = [`${this.path}.1`, this.path];
    const contents = await Promise.all(
      paths.map((path) => readFile(path, "utf8").catch(() => "")),
    );
    return contents
      .flatMap((content) => content.split("\n"))
      .flatMap((line) => {
        if (!line.trim()) return [];
        try {
          const value = JSON.parse(line) as unknown;
          return isProviderDiagnostic(value) ? [value] : [];
        } catch {
          return [];
        }
      })
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
      .slice(0, Math.max(1, Math.min(limit, 1_000)));
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  async report(
    metadata: Record<string, string>,
    limit = 200,
  ): Promise<{ count: number; text: string }> {
    const records = await this.list(limit);
    const header = [
      "Coworker provider error report",
      `Generated: ${new Date().toISOString()}`,
      ...Object.entries(metadata).map(([key, value]) => `${key}: ${value}`),
      `Entries: ${records.length}`,
      "Privacy: prompts and credentials are excluded; secret-like values are redacted.",
    ];
    return {
      count: records.length,
      text: `${header.join("\n")}\n\n${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    };
  }

  private async rotateIfNeeded(): Promise<void> {
    const current = await stat(this.path).catch(() => null);
    if (!current || current.size < maxLogBytes) return;
    const previousPath = `${this.path}.1`;
    await rm(previousPath, { force: true });
    await rename(this.path, previousPath);
  }
}

function isProviderDiagnostic(value: unknown): value is ProviderErrorDiagnostic {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.timestamp === "string" &&
    record.level === "error" &&
    record.category === "model_provider" &&
    typeof record.phase === "string" &&
    providerErrorPhases.includes(record.phase as ProviderErrorPhase) &&
    typeof record.provider === "string" &&
    (modelProviders.includes(record.provider as KnownModelProvider) ||
      isCustomModelProvider(record.provider)) &&
    typeof record.message === "string"
  );
}
