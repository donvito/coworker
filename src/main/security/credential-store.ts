import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { safeStorage } from "electron";

export interface CredentialStore {
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  status?(key: string): Promise<CredentialReadStatus>;
}

export type CredentialReadStatus = "configured" | "missing" | "unreadable";

export class CredentialDecryptionError extends Error {
  readonly code = "CREDENTIAL_DECRYPTION_FAILED";

  constructor(options?: ErrorOptions) {
    super(
      "This saved credential was encrypted by a different app identity. Re-enter it in Settings.",
      options,
    );
    this.name = "CredentialDecryptionError";
  }
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
    let encrypted: Buffer;
    try {
      encrypted = await readFile(this.pathFor(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      return safeStorage.decryptString(encrypted);
    } catch (error) {
      throw new CredentialDecryptionError({ cause: error });
    }
  }

  async has(key: string): Promise<boolean> {
    return (await this.status(key)) === "configured";
  }

  async status(key: string): Promise<CredentialReadStatus> {
    try {
      return (await this.get(key)) === null ? "missing" : "configured";
    } catch (error) {
      if (error instanceof CredentialDecryptionError) return "unreadable";
      throw error;
    }
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

  async status(key: string): Promise<CredentialReadStatus> {
    return this.values.has(key) ? "configured" : "missing";
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}
