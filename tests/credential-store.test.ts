import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

const safeStorage = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(value, "utf8")),
  decryptString: vi.fn((value: Buffer) => value.toString("utf8")),
}));

vi.mock("electron", () => ({ safeStorage }));

import {
  CredentialDecryptionError,
  SecureCredentialStore,
} from "@main/security/credential-store";
import { DesktopAppService } from "@main/app/app-service";

const temporaryPaths: string[] = [];

afterEach(async () => {
  safeStorage.isEncryptionAvailable.mockReturnValue(true);
  safeStorage.encryptString.mockImplementation((value: string) => Buffer.from(value, "utf8"));
  safeStorage.decryptString.mockImplementation((value: Buffer) => value.toString("utf8"));
  vi.unstubAllGlobals();
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("secure credential storage", () => {
  it("reports identity-mismatched ciphertext without breaking status checks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coworker-credentials-"));
    temporaryPaths.push(directory);
    const store = new SecureCredentialStore(directory);
    await store.set("model:openrouter", "secret");
    safeStorage.decryptString.mockImplementation(() => {
      throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString");
    });

    await expect(store.get("model:openrouter")).rejects.toBeInstanceOf(
      CredentialDecryptionError,
    );
    await expect(store.status("model:openrouter")).resolves.toBe("unreadable");
    await expect(store.has("model:openrouter")).resolves.toBe(false);
  });

  it("allows an unreadable credential to be replaced", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coworker-credentials-"));
    temporaryPaths.push(directory);
    const store = new SecureCredentialStore(directory);
    await store.set("model:openrouter", "old-secret");
    safeStorage.decryptString.mockImplementation(() => {
      throw new Error("Could not decrypt");
    });
    await expect(store.status("model:openrouter")).resolves.toBe("unreadable");

    safeStorage.decryptString.mockImplementation((value: Buffer) => value.toString("utf8"));
    await store.set("model:openrouter", "new-secret");

    await expect(store.get("model:openrouter")).resolves.toBe("new-secret");
    await expect(store.status("model:openrouter")).resolves.toBe("configured");
  });

  it("configures a model from a submitted key without reading legacy ciphertext", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coworker-model-config-"));
    temporaryPaths.push(directory);
    const model = openrouterProvider().getModels()[0]!;
    const set = vi.fn(async () => undefined);
    const get = vi.fn(async () => {
      throw new CredentialDecryptionError();
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ id: model.id }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const service = new DesktopAppService({
      dataPath: directory,
      credentials: {
        set,
        get,
        async has() {
          return false;
        },
        async delete() {},
      },
    });
    try {
      await expect(
        service.configureModel({ provider: "openrouter", apiKey: "replacement-key" }),
      ).resolves.toMatchObject({ configured: true });
      expect(get).not.toHaveBeenCalled();
      expect(set).toHaveBeenCalledWith("model:openrouter", "replacement-key");
    } finally {
      service.database.close();
    }
  });
});
