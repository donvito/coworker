import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { safeStorage } from "electron";

export interface CredentialStore {
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

export class SecureCredentialStore implements CredentialStore {
  constructor(private readonly directory: string) {}

  private pathFor(key: string): string {
    const name = createHash("sha256").update(key).digest("hex");
    return join(this.directory, `${name}.credential`);
  }

  async set(key: string, value: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Secure credential storage is not available on this computer");
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const encrypted = safeStorage.encryptString(value);
    await writeFile(this.pathFor(key), encrypted, { mode: 0o600 });
  }

  async get(key: string): Promise<string | null> {
    if (!safeStorage.isEncryptionAvailable()) return null;
    try {
      const encrypted = await readFile(this.pathFor(key));
      return safeStorage.decryptString(encrypted);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}

export class MemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, string>();

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async has(key: string): Promise<boolean> {
    return this.values.has(key);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}
