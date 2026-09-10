import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { exportLogs, followLogs, readLogs } from "@main/control/logs";
import { ApplicationLogger } from "@main/runtime/application-logger";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cw-logs-")); roots.push(root);
  await mkdir(join(root, "logs"));
  return { root, file: join(root, "logs", "app.jsonl") };
}
const record = (message: string, seconds: number, level = "info") => JSON.stringify({ timestamp: `2026-01-01T00:00:${String(seconds).padStart(2, "0")}Z`, level, message }) + "\n";

describe("terminal diagnostic logs", () => {
  it("reads offline with source, level, time and limit filters; tolerates partial and malformed lines", async () => {
    const { root, file } = await fixture();
    await writeFile(`${file}.1`, record("old", 0));
    await writeFile(file, record("info", 1) + "not json\n" + record("error", 2, "error") + '{"partial":');
    await writeFile(join(root, "logs", "provider-errors.jsonl"), record("provider", 3, "error"));
    expect((await readLogs(root, { level: "error" })).map((entry) => entry.message)).toEqual(["error", "provider"]);
    expect((await readLogs(root, { source: "app", since: "2026-01-01T00:00:01Z", limit: 1 })).map((entry) => entry.message)).toEqual(["error"]);
    await expect(readLogs(root, { since: "tomorrow" })).rejects.toThrow();
  });

  it("follows rotation without replaying retained records or losing appended records", async () => {
    const { root, file } = await fixture();
    await writeFile(file, record("first", 1));
    const abort = new AbortController();
    const stream = followLogs(root, {}, abort.signal, 5);
    expect((await stream.next()).value?.message).toBe("first");
    await appendFile(file, record("second", 2));
    await rename(file, `${file}.1`);
    await writeFile(file, record("third", 3));
    expect((await stream.next()).value?.message).toBe("second");
    expect((await stream.next()).value?.message).toBe("third");
    abort.abort();
    expect((await stream.next()).done).toBe(true);
  });

  it("exports a readable support ZIP, refuses overwrite by default, and excludes profile secrets", async () => {
    const { root, file } = await fixture();
    const logger = new ApplicationLogger(file);
    await logger.info("test", "A harmless diagnostic");
    await writeFile(join(root, "credentials"), "never export this");
    const destination = join(root, "support.zip");
    await exportLogs(root, destination);
    const first = await readFile(destination);
    const archive = await JSZip.loadAsync(first);
    expect(Object.keys(archive.files)).toContain("logs/app.jsonl");
    expect(Object.keys(archive.files)).not.toContain("credentials");
    expect(await archive.file("logs/app.jsonl")!.async("string")).toContain("harmless diagnostic");
    await expect(exportLogs(root, destination)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(destination)).toEqual(first);
    await exportLogs(root, destination, true);
    await expect(exportLogs(root, join(root, "coworker.db"), true)).rejects.toThrow(".zip");
  });
});
