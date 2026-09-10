import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { createSupportBundle } from "@main/integrations/archives";
import { ApplicationLogger } from "@main/runtime/application-logger";
import { ProviderErrorLogger } from "@main/runtime/provider-error-logger";

export const logQuerySchema = z.object({
  source: z.enum(["all", "app", "provider"]).default("all"),
  level: z.enum(["debug", "info", "warning", "error"]).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(10_000).default(100),
}).strict().refine((query) => !query.since || !query.until || Date.parse(query.since) <= Date.parse(query.until),
  "since must precede until");
export type LogQuery = z.input<typeof logQuerySchema>;
export interface LogRecord { source: "app" | "provider"; timestamp: string; level: string; [key: string]: unknown }

async function readRecords(dataPath: string, query: LogQuery): Promise<LogRecord[]> {
  const parsed = logQuerySchema.parse(query);
  const sources = parsed.source === "all" ? ["app", "provider"] as const : [parsed.source];
  const records: LogRecord[] = [];
  for (const source of sources) {
    const base = join(dataPath, "logs", source === "app" ? "app.jsonl" : "provider-errors.jsonl");
    for (const path of [`${base}.1`, base]) {
      const content = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      // Ignore the final partial line while another process is appending.
      for (const line of content.split("\n").slice(0, -1)) {
        try {
          const record = JSON.parse(line);
          if (!record || typeof record.timestamp !== "string" || typeof record.level !== "string") continue;
          if (parsed.level && record.level !== parsed.level) continue;
          const timestamp = Date.parse(record.timestamp);
          if (!Number.isFinite(timestamp)) continue;
          if (parsed.since && timestamp < Date.parse(parsed.since)) continue;
          if (parsed.until && timestamp > Date.parse(parsed.until)) continue;
          records.push({ ...record, source });
        } catch { /* Malformed diagnostic lines do not hide subsequent records. */ }
      }
    }
  }
  return records.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

export async function readLogs(dataPath: string, query: LogQuery = {}): Promise<LogRecord[]> {
  return (await readRecords(dataPath, query)).slice(-logQuerySchema.parse(query).limit);
}

export async function* followLogs(dataPath: string, query: LogQuery, signal: AbortSignal, intervalMs = 500) {
  // Both retained files are scanned, so replacement/rotation does not strand an open descriptor.
  let seen = new Map<string, number>();
  let first = true;
  while (!signal.aborted) {
    const records = await readRecords(dataPath, query);
    const current = new Map<string, number>();
    const fresh: LogRecord[] = [];
    for (const record of records) {
      const key = JSON.stringify(record);
      const count = (current.get(key) ?? 0) + 1;
      current.set(key, count);
      if (count > (seen.get(key) ?? 0)) fresh.push(record);
    }
    for (const record of first ? fresh.slice(-logQuerySchema.parse(query).limit) : fresh) yield record;
    seen = current;
    first = false;
    try { await setTimeout(intervalMs, undefined, { signal }); }
    catch (error) { if (!signal.aborted) throw error; }
  }
}

export async function exportLogs(dataPath: string, destination: string, overwrite = false,
  loggers?: { application: ApplicationLogger; provider: ProviderErrorLogger }, metadata: Record<string, string> = {}) {
  if (extname(destination).toLowerCase() !== ".zip") throw new Error("Log export destination must end in .zip");
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(join(dirname(destination), ".coworker-logs-"));
  try {
    const temporary = join(staging, "support.zip");
    await createSupportBundle({
      destinationPath: temporary,
      logger: loggers?.application ?? new ApplicationLogger(join(dataPath, "logs", "app.jsonl")),
      providerLogger: loggers?.provider ?? new ProviderErrorLogger(join(dataPath, "logs", "provider-errors.jsonl")),
      metadata: { Platform: `${process.platform} ${process.arch}`, Node: process.versions.node, ...metadata },
    });
    if (overwrite) await rename(temporary, destination);
    else await copyFile(temporary, destination, constants.COPYFILE_EXCL);
    return { path: destination };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
