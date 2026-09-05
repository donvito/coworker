import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readControlDescriptor, requestControl, startControlServer } from "@main/control/transport";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(invoke = vi.fn(async (_method: string, _args: unknown[]): Promise<unknown> => ({ answer: 42 }))) {
  const root = await mkdtemp(join(tmpdir(), "cw-control-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const audit = vi.fn(async () => {});
  const server = await startControlServer({ dataPath: root, invoke, audit });
  cleanups.push(server.close);
  return { root, server, invoke, audit };
}

describe("local administration transport", () => {
  it("serves authenticated bounded requests and audits method names without payloads", async () => {
    const { root, invoke, audit } = await fixture();
    const result = await requestControl(root, "configure", [{ apiKey: "test-secret" }]);
    expect(result).toEqual({ answer: 42 });
    expect(invoke).toHaveBeenCalledWith("configure", [{ apiKey: "test-secret" }]);
    expect(audit.mock.calls).toEqual([["configure", true]]);
    if (process.platform !== "win32") {
      expect((await stat(join(root, ".control"))).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, ".control", "owner.json"))).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects a wrong token without invoking or auditing supplied method names", async () => {
    const { root, invoke, audit } = await fixture();
    const file = join(root, ".control", "owner.json");
    const descriptor = await readControlDescriptor(root);
    await writeFile(file, JSON.stringify({ ...descriptor, token: "a".repeat(64) }));
    await expect(requestControl(root, "untrusted method", [])).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(invoke).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    await writeFile(file, JSON.stringify(descriptor));
  });

  it("isolates profiles and replaces a stale descriptor without trusting an old token", async () => {
    const first = await fixture();
    const second = await fixture();
    expect((await readControlDescriptor(first.root)).nonce).not.toBe((await readControlDescriptor(second.root)).nonce);
    await requestControl(second.root, "status");
    expect(first.invoke).not.toHaveBeenCalled();
    const stale = await readFile(join(first.root, ".control", "owner.json"));
    await first.server.close();
    cleanups.splice(cleanups.indexOf(first.server.close), 1);
    await writeFile(join(first.root, ".control", "owner.json"), stale, { mode: 0o600 });
    await expect(requestControl(first.root, "status")).rejects.toMatchObject({ code: "NOT_RUNNING" });
    const next = await startControlServer({ dataPath: first.root, invoke: async () => "new owner" });
    cleanups.push(next.close);
    expect(await requestControl(first.root, "status")).toBe("new owner");
  });

  it("reports protocol incompatibility and refuses permissive control files", async () => {
    const { root } = await fixture();
    const file = join(root, ".control", "owner.json");
    const descriptor = await readControlDescriptor(root);
    await writeFile(file, JSON.stringify({ ...descriptor, version: 2 }));
    await expect(requestControl(root, "status")).rejects.toMatchObject({ code: "VERSION" });
    await writeFile(file, JSON.stringify(descriptor));
    if (process.platform !== "win32") {
      await chmod(file, 0o644);
      await expect(requestControl(root, "status")).rejects.toMatchObject({ code: "UNTRUSTED_OWNER" });
      await chmod(file, 0o600);
    }
  });

  it("rejects oversized requests before execution and reports timeouts without retrying", async () => {
    const { root, invoke } = await fixture();
    await expect(requestControl(root, "large", ["x".repeat(16 * 1024 * 1024)])).rejects.toMatchObject({ code: "VALIDATION" });
    expect(invoke).not.toHaveBeenCalled();
    let release!: () => void;
    invoke.mockImplementationOnce(() => new Promise<void>((done) => { release = done; }));
    const waiting = requestControl(root, "slow", [], { timeoutMs: 50 });
    await expect(waiting).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(invoke).toHaveBeenCalledTimes(1);
    release();
  });

  it("drains an in-flight mutation before removing the owner descriptor", async () => {
    let release!: () => void;
    const invoke = vi.fn(() => new Promise<void>((done) => { release = done; }));
    const { root, server } = await fixture(invoke);
    const request = requestControl(root, "mutate");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    const closing = server.close();
    await expect(readControlDescriptor(root)).resolves.toBeDefined();
    release();
    await expect(request).resolves.toBeNull();
    await closing;
    cleanups.splice(cleanups.indexOf(server.close), 1);
    await expect(requestControl(root, "status")).rejects.toMatchObject({ code: "NOT_RUNNING" });
  });
});
