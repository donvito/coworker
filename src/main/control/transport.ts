import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { redactProviderDiagnostic } from "@main/runtime/provider-error-logger";

export const controlVersion = 1;
const maxFrameBytes = 16 * 1024 * 1024;
const timeoutMs = 30_000;
const descriptorSchema = z.object({
  version: z.literal(controlVersion),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  nonce: z.string().regex(/^[a-f0-9]{24}$/),
  pid: z.number().int().positive(),
});
export type ControlDescriptor = z.infer<typeof descriptorSchema>;
const requestSchema = z.object({
  version: z.literal(controlVersion),
  token: z.string().max(128),
  method: z.string().min(1).max(120),
  args: z.array(z.unknown()).max(3),
}).strict();

export class ControlError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function controlDirectory(dataPath: string): string { return join(dataPath, ".control"); }
function socketDirectory(dataPath: string): string {
  const hash = createHash("sha256").update(resolve(dataPath)).digest("hex").slice(0, 20);
  return join(tmpdir().length <= 30 ? tmpdir() : "/tmp", `cw-${process.getuid?.() ?? "user"}-${hash}`);
}
function endpoint(dataPath: string, nonce: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\coworker-${nonce}`
    : join(socketDirectory(dataPath), `${nonce}.sock`);
}
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) {
    throw new Error("Control directory must be owned by the current user and cannot be a symlink");
  }
  await chmod(path, 0o700);
}

export async function readControlDescriptor(dataPath: string): Promise<ControlDescriptor> {
  try {
    const directory = controlDirectory(dataPath);
    for (const path of [directory, join(directory, "owner.json")]) {
      const info = await lstat(path);
      if (info.isSymbolicLink() || (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077)))) {
        throw new ControlError("UNTRUSTED_OWNER", "Coworker control files must be private to the current user");
      }
    }
    const file = join(directory, "owner.json");
    if ((await lstat(file)).size > 8192) throw new ControlError("UNTRUSTED_OWNER", "Invalid control descriptor");
    const value = JSON.parse(await readFile(file, "utf8"));
    if (value.version !== controlVersion) throw new ControlError("VERSION", "CLI and app protocol versions differ; reinstall the CLI");
    const parsed = descriptorSchema.safeParse(value);
    if (!parsed.success) throw new ControlError("UNTRUSTED_OWNER", "Invalid control descriptor");
    return parsed.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ControlError("NOT_RUNNING", "Coworker is stopped. Run coworker start first.");
    }
    throw error;
  }
}

export async function requestControl<T = unknown>(
  dataPath: string, method: string, args: unknown[] = [], options: { timeoutMs?: number } = {},
): Promise<T> {
  const owner = await readControlDescriptor(dataPath);
  return new Promise<T>((resolveResult, reject) => {
    const socket = createConnection(endpoint(dataPath, owner.nonce));
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new ControlError("TIMEOUT", "Coworker did not reply in time. Check status before retrying a mutation."));
    }, options.timeoutMs ?? timeoutMs);
    let buffer = "";
    let bytes = 0;
    let received = false;
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      const frame = JSON.stringify({ version: controlVersion, token: owner.token, method, args }) + "\n";
      if (Buffer.byteLength(frame) > maxFrameBytes) {
        socket.destroy(new ControlError("VALIDATION", "Control request exceeds 16 MB"));
      } else socket.write(frame);
    });
    socket.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxFrameBytes) { socket.destroy(new Error("Control response exceeds 16 MB")); return; }
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      received = true;
      try {
        const result = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        if (result.version !== controlVersion) throw new ControlError("VERSION", "CLI and app protocol versions differ");
        if (!result.ok) throw new ControlError(result.code ?? "FAILED", result.error ?? "Command failed");
        resolveResult(result.result as T);
      } catch (error) { reject(error); }
      socket.destroy();
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      reject(["ENOENT", "ECONNREFUSED"].includes(error.code ?? "")
        ? new ControlError("NOT_RUNNING", "Coworker is stopped. Run coworker start first.") : error);
    });
    socket.once("close", () => {
      clearTimeout(timer);
      if (!received) reject(new ControlError("DISCONNECTED", "Coworker disconnected. Check status before retrying a mutation."));
    });
  });
}

export async function startControlServer(input: {
  dataPath: string;
  invoke: (method: string, args: unknown[]) => Promise<unknown>;
  audit?: (method: string, success: boolean) => Promise<void>;
}): Promise<{ close: () => Promise<void> }> {
  await privateDirectory(controlDirectory(input.dataPath));
  if (process.platform !== "win32") await privateDirectory(socketDirectory(input.dataPath));
  const owner: ControlDescriptor = {
    version: controlVersion, pid: process.pid,
    token: randomBytes(32).toString("hex"), nonce: randomBytes(12).toString("hex"),
  };
  const address = endpoint(input.dataPath, owner.nonce);
  const sockets = new Set<Socket>();
  const pending = new Set<Promise<void>>();
  let closing = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    const deadline = setTimeout(() => socket.destroy(), timeoutMs);
    socket.once("close", () => { clearTimeout(deadline); sockets.delete(socket); });
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => socket.destroy());
    let buffer = "";
    let bytes = 0;
    let handled = false;
    const finish = (value: object) => {
      const frame = JSON.stringify({ version: controlVersion, ...value }) + "\n";
      socket.end(Buffer.byteLength(frame) <= maxFrameBytes ? frame :
        JSON.stringify({ version: controlVersion, ok: false, code: "TOO_LARGE", error: "Result exceeds 16 MB; narrow the request" }) + "\n");
    };
    socket.on("data", (chunk: string) => {
      if (handled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxFrameBytes) { handled = true; socket.destroy(); return; }
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      handled = true;
      const work = (async () => {
        let method: string | undefined;
        try {
          const envelope = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
          if (envelope?.version !== controlVersion) throw new ControlError("VERSION", "CLI and app protocol versions differ");
          const request = requestSchema.parse(envelope);
          const token = Buffer.from(request.token);
          const expected = Buffer.from(owner.token);
          if (token.length !== expected.length || !timingSafeEqual(token, expected)) {
            throw new ControlError("UNAUTHORIZED", "Unauthorized control request");
          }
          if (closing) throw new ControlError("STOPPING", "Coworker is shutting down");
          method = request.method;
          const result = await input.invoke(method, request.args);
          await input.audit?.(method, true);
          finish({ ok: true, result: result ?? null });
        } catch (error) {
          if (method) await input.audit?.(method, false);
          finish({ ok: false, code: error instanceof ControlError ? error.code : "FAILED",
            error: redactProviderDiagnostic(error instanceof Error ? error.message : String(error)) });
        }
      })();
      pending.add(work);
      void work.finally(() => pending.delete(work)).catch(() => socket.destroy());
    });
  });
  server.maxConnections = 64;
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(address, () => { server.removeListener("error", reject); done(); });
  });
  try {
    if (process.platform !== "win32") await chmod(address, 0o600);
    const temporary = join(controlDirectory(input.dataPath), `${owner.nonce}.tmp`);
    await writeFile(temporary, JSON.stringify(owner), { mode: 0o600, flag: "wx" });
    await rename(temporary, join(controlDirectory(input.dataPath), "owner.json"));
  } catch (error) { server.close(); if (process.platform !== "win32") await rm(address, { force: true }); throw error; }
  return {
    async close() {
      closing = true;
      const closed = new Promise<void>((done) => server.close(() => done()));
      await Promise.allSettled([...pending]);
      for (const socket of sockets) socket.destroy();
      await closed;
      const current = await readControlDescriptor(input.dataPath).catch(() => null);
      if (current?.nonce === owner.nonce) await rm(join(controlDirectory(input.dataPath), "owner.json"), { force: true });
      if (process.platform !== "win32") await rm(address, { force: true });
    },
  };
}
