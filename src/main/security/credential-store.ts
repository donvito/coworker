import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, chmod } from "node:fs/promises";
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

export class CredentialStorageUnavailableError extends Error {
  readonly code = "CREDENTIAL_STORAGE_UNAVAILABLE";

  constructor() {
    super("Secure credential storage is not available on this computer");
    this.name = "CredentialStorageUnavailableError";
  }
}

export class SecureCredentialStore implements CredentialStore {
  constructor(private readonly directory: string) {}

  private pathFor(key: string): string {
    const name = createHash("sha256").update(key).digest("hex");
    return join(this.directory, `${name}.credential`);
  }

  private ensureSecureStorage(): void {
    if (!safeStorage.isEncryptionAvailable()) throw new CredentialStorageUnavailableError();
    // Electron's Linux basic_text backend does not protect secrets at rest. Do
    // not save OAuth refresh tokens or API keys when no desktop keyring exists.
    if (
      process.platform === "linux" &&
      typeof safeStorage.getSelectedStorageBackend === "function" &&
      safeStorage.getSelectedStorageBackend() === "basic_text"
    ) {
      throw new CredentialStorageUnavailableError();
    }
  }

  async set(key: string, value: string): Promise<void> {
    this.ensureSecureStorage();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const encrypted = safeStorage.encryptString(value);
    const target = this.pathFor(key);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(encrypted);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
      await chmod(target, 0o600);
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async get(key: string): Promise<string | null> {
    if (!safeStorage.isEncryptionAvailable()) return null;
    this.ensureSecureStorage();
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
      if (
        error instanceof CredentialDecryptionError ||
        error instanceof CredentialStorageUnavailableError
      ) return "unreadable";
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
