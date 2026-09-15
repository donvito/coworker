import type { Integration } from "@shared/contracts";

interface Bridge {
  start(): Promise<void>;
  stop(): Promise<void>;
  wake(): Promise<void>;
  isRunning(): boolean;
}

/** Serializes each connection's lifecycle while allowing other bots to run independently. */
export class BridgeManager<T extends Bridge> {
  private readonly bridges = new Map<string, T>();
  private readonly operations = new Map<string, Promise<void>>();

  constructor(private readonly options: {
    list(): Integration[];
    create(integration: Integration): T;
    onError?(id: string, error: unknown): void;
  }) {}

  get(id: string): T | undefined { return this.bridges.get(id); }

  isRunning(id?: string): boolean {
    return id ? Boolean(this.bridges.get(id)?.isRunning()) : [...this.bridges.values()].some(bridge => bridge.isRunning());
  }

  private async operate(id: string | undefined, action: "start" | "stop" | "restart" | "wake"): Promise<void> {
    const rows = this.options.list();
    const ids = id ? [id] : [...new Set([...rows.map(row => row.id), ...this.bridges.keys()])];
    const results = await Promise.allSettled(ids.map(key => {
      const previous = this.operations.get(key) ?? Promise.resolve();
      const operation = previous.catch(() => undefined).then(async () => {
        let bridge = this.bridges.get(key);
        if (!bridge && action !== "stop") {
          const row = rows.find(candidate => candidate.id === key);
          if (!row) throw new Error(`Bot connection ${key} was not found`);
          bridge = this.options.create(row);
          this.bridges.set(key, bridge);
        }
        if (!bridge) return;
        if (action === "restart") { await bridge.stop(); await bridge.start(); }
        else await bridge[action]();
      });
      this.operations.set(key, operation);
      void operation.finally(() => {
        if (this.operations.get(key) === operation) this.operations.delete(key);
      }).catch(() => undefined);
      return operation;
    }));
    for (const [index, result] of results.entries()) {
      if (result.status !== "rejected") continue;
      this.options.onError?.(ids[index]!, result.reason);
      // A targeted operation reports its failure to the settings caller. A
      // provider-wide wake/start must still leave other connections available.
      if (id || action === "stop") throw result.reason;
    }
  }

  start(id?: string): Promise<void> { return this.operate(id, "start"); }
  stop(id?: string): Promise<void> { return this.operate(id, "stop"); }
  restart(id?: string): Promise<void> { return this.operate(id, "restart"); }
  wake(id?: string): Promise<void> { return this.operate(id, "wake"); }
}
