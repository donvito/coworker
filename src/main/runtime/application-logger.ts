import { appendFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redactProviderDiagnostic } from "./provider-error-logger";

export type ApplicationLogLevel = "debug" | "info" | "warning" | "error";

export interface ApplicationLogRecord {
  timestamp: string;
  level: ApplicationLogLevel;
  category: string;
  message: string;
  stack?: string;
  details?: Record<string, string | number | boolean | null>;
}

const maxLogBytes = 5 * 1024 * 1024;

function diagnosticError(error: unknown): { message: string; stack?: string } {
  const source = error instanceof Error ? error : new Error(String(error));
  return {
    message: redactProviderDiagnostic(source.message).slice(0, 4_000),
    stack: source.stack
      ? redactProviderDiagnostic(source.stack).slice(0, 12_000)
      : undefined,
  };
}

function safeDetails(
  details: Record<string, string | number | boolean | null> | undefined,
): Record<string, string | number | boolean | null> | undefined {
  if (!details) return undefined;
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key,
      typeof value === "string" ? redactProviderDiagnostic(value).slice(0, 2_000) : value,
    ]),
  );
}

export class ApplicationLogger {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  debug(
    category: string,
    message: string,
    details?: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    return this.write("debug", category, message, undefined, details);
  }

  info(
    category: string,
    message: string,
    details?: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    return this.write("info", category, message, undefined, details);
  }

  warning(
    category: string,
    message: string,
    details?: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    return this.write("warning", category, message, undefined, details);
  }

  error(
    category: string,
    error: unknown,
    details?: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    const diagnostic = diagnosticError(error);
    return this.write("error", category, diagnostic.message, diagnostic.stack, details);
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  emergency(
    category: string,
    error: unknown,
    details?: Record<string, string | number | boolean | null>,
  ): void {
    const diagnostic = diagnosticError(error);
    const record: ApplicationLogRecord = {
      timestamp: new Date().toISOString(),
      level: "error",
      category: category.slice(0, 120),
      message: diagnostic.message,
      stack: diagnostic.stack,
      details: safeDetails(details),
    };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch (writeError) {
      console.error("Could not write emergency application diagnostic log", writeError);
    }
  }

  async readFiles(): Promise<Array<{ name: string; content: string }>> {
    await this.writeQueue;
    const candidates = [
      { name: "app.jsonl.1", path: `${this.path}.1` },
      { name: "app.jsonl", path: this.path },
    ];
    const files = await Promise.all(
      candidates.map(async (candidate) => ({
        name: candidate.name,
        content: await readFile(candidate.path, "utf8").catch(() => ""),
      })),
    );
    return files.filter((file) => file.content.length > 0);
  }

  private write(
    level: ApplicationLogLevel,
    category: string,
    message: string,
    stack?: string,
    details?: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    const record: ApplicationLogRecord = {
      timestamp: new Date().toISOString(),
      level,
      category: category.slice(0, 120),
      message: redactProviderDiagnostic(message).slice(0, 4_000),
      stack,
      details: safeDetails(details),
    };
    this.writeQueue = this.writeQueue
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        await this.rotateIfNeeded();
        await appendFile(this.path, `${JSON.stringify(record)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
      })
      .catch((writeError) => {
        // Diagnostics must never make an application failure worse.
        console.error("Could not write application diagnostic log", writeError);
      });
    return this.writeQueue;
  }

  private async rotateIfNeeded(): Promise<void> {
    const current = await stat(this.path).catch(() => null);
    if (!current || current.size < maxLogBytes) return;
    await rm(`${this.path}.1`, { force: true });
    await rename(this.path, `${this.path}.1`);
  }
}
