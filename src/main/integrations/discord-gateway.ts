import {
  DiscordApiError,
  DiscordRestApi,
  discordGatewayIntents,
  type DiscordChannel,
  type DiscordInteraction,
  type DiscordMessage,
  type DiscordWebSocketConstructor,
} from "./discord";

export const discordOpcode = {
  dispatch: 0,
  heartbeat: 1,
  identify: 2,
  resume: 6,
  reconnect: 7,
  invalidSession: 9,
  hello: 10,
  heartbeatAck: 11,
} as const;

export interface DiscordGatewayDispatch {
  t: string;
  d: unknown;
  s: number | null;
}

export interface DiscordGatewayHandlers {
  onReady?: (sessionId: string, resumeUrl?: string) => void;
  onDispatch?: (event: DiscordGatewayDispatch) => void | Promise<void>;
  onConflict?: (reason: string) => void;
  onClose?: (code: number, reason: string) => void;
  onError?: (scope: string, error: unknown) => void;
  onSequence?: (sequence: number | null, sessionId: string | null) => void;
}

export interface DiscordGatewayOptions {
  token: string;
  api: DiscordRestApi;
  handlers: DiscordGatewayHandlers;
  WebSocketImpl?: DiscordWebSocketConstructor;
  /** Resume after reconnect when both are present. */
  sessionId?: string | null;
  lastSequence?: number | null;
}

const maxBackoffMs = 60_000;
const conflictPauseMs = 60_000;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Raw Discord Gateway: identify, heartbeat, resume, and dispatch.
 * Uses Node's built-in WebSocket — no discord.js.
 */
export class DiscordGateway {
  private socket: WebSocket | null = null;
  private running = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatIntervalMs = 41_250;
  private sequence: number | null;
  private sessionId: string | null;
  private resumeUrl: string | null = null;
  private identified = false;
  private connectLoop: Promise<void> = Promise.resolve();
  private abort: AbortController | null = null;
  private backoffMs = 1_000;

  constructor(private readonly options: DiscordGatewayOptions) {
    this.sequence = options.lastSequence ?? null;
    this.sessionId = options.sessionId ?? null;
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.connectLoop = this.loop().catch((error) => {
      this.options.handlers.onError?.("discord.gateway", error);
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    this.teardownSocket(1000, "stopped");
    await this.connectLoop.catch(() => undefined);
  }

  /** Close and reconnect (OS resume / reconfigure). */
  async wake(): Promise<void> {
    if (!this.running) {
      await this.start();
      return;
    }
    this.teardownSocket(1000, "wake");
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const signal = this.abort?.signal;
      try {
        await this.connectOnce();
        this.backoffMs = 1_000;
      } catch (error) {
        if (!this.running || signal?.aborted) return;
        this.options.handlers.onError?.("discord.gateway", error);
        if (error instanceof DiscordApiError && error.status === 401) {
          this.options.handlers.onConflict?.("Discord rejected the bot token");
          await delay(conflictPauseMs, signal);
          continue;
        }
        await delay(Math.min(this.backoffMs, maxBackoffMs), signal);
        this.backoffMs = Math.min(this.backoffMs * 2, maxBackoffMs);
      }
    }
  }

  private async connectOnce(): Promise<void> {
    const signal = this.abort?.signal;
    if (!this.running || signal?.aborted) return;
    const WebSocketImpl = this.options.WebSocketImpl ?? WebSocket;
    let gatewayUrl = this.resumeUrl;
    if (!gatewayUrl) {
      const gateway = await this.options.api.getGateway();
      if (!this.running || signal?.aborted) return;
      gatewayUrl = gateway.url;
    }
    const url = this.withGatewayQuery(gatewayUrl);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error instanceof Error ? error : new Error(String(error)));
        else resolve();
      };
      const onAbort = () => {
        this.teardownSocket(1000, "stopped");
        finish();
      };

      let socket: WebSocket;
      try {
        socket = new WebSocketImpl(url);
      } catch (error) {
        finish(error);
        return;
      }
      this.socket = socket;
      this.identified = false;
      signal?.addEventListener("abort", onAbort, { once: true });
      if (!this.running || signal?.aborted) {
        onAbort();
        return;
      }

      socket.addEventListener("open", () => {
        // HELLO arrives as the first payload; identify after that.
      });
      socket.addEventListener("message", (event) => {
        void this.handlePayload(String((event as MessageEvent).data)).catch((error) => {
          this.options.handlers.onError?.("discord.gateway", error);
        });
      });
      socket.addEventListener("error", () => {
        // close follows; avoid leaking token-bearing URLs from the event.
      });
      socket.addEventListener("close", (event) => {
        const close = event as CloseEvent;
        this.clearHeartbeat();
        this.socket = null;
        this.options.handlers.onClose?.(close.code, close.reason ?? "");
        if (close.code === 4004) {
          finish(new DiscordApiError(401, "authentication failed"));
          return;
        }
        if (close.code === 4005 || close.code === 4010) {
          this.sessionId = null;
          this.options.handlers.onConflict?.(
            "Another process is using this Discord bot; pausing this bridge for a minute",
          );
        }
        finish();
      });
    });
  }

  private withGatewayQuery(url: string): string {
    try {
      const parsed = new URL(url);
      parsed.searchParams.set("v", "10");
      parsed.searchParams.set("encoding", "json");
      return parsed.toString();
    } catch {
      const separator = url.includes("?") ? "&" : "?";
      return `${url}${separator}v=10&encoding=json`;
    }
  }

  private async handlePayload(raw: string): Promise<void> {
    let payload: { op: number; d?: unknown; s?: number | null; t?: string | null };
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      return;
    }
    if (typeof payload.s === "number") {
      this.sequence = payload.s;
      this.options.handlers.onSequence?.(this.sequence, this.sessionId);
    }

    if (payload.op === discordOpcode.hello) {
      const hello = payload.d as { heartbeat_interval?: number } | undefined;
      this.heartbeatIntervalMs = hello?.heartbeat_interval ?? 41_250;
      this.startHeartbeat();
      this.identifyOrResume();
      return;
    }
    if (payload.op === discordOpcode.heartbeat) {
      this.send({ op: discordOpcode.heartbeat, d: this.sequence });
      return;
    }
    if (payload.op === discordOpcode.reconnect) {
      this.teardownSocket(4000, "reconnect");
      return;
    }
    if (payload.op === discordOpcode.invalidSession) {
      const resumable = payload.d === true;
      if (!resumable) {
        this.sessionId = null;
        this.sequence = null;
        this.options.handlers.onSequence?.(null, null);
        this.options.handlers.onConflict?.(
          "Another process is using this Discord bot; pausing this bridge for a minute",
        );
      }
      this.teardownSocket(4000, "invalid session");
      return;
    }
    if (payload.op !== discordOpcode.dispatch || !payload.t) return;

    if (payload.t === "READY") {
      const ready = payload.d as { session_id?: string; resume_gateway_url?: string };
      this.sessionId = ready.session_id ?? this.sessionId;
      this.resumeUrl = ready.resume_gateway_url ?? this.resumeUrl;
      this.identified = true;
      this.options.handlers.onSequence?.(this.sequence, this.sessionId);
      this.options.handlers.onReady?.(this.sessionId ?? "", this.resumeUrl ?? undefined);
    }
    if (payload.t === "RESUMED") {
      this.identified = true;
    }

    await this.options.handlers.onDispatch?.({
      t: payload.t,
      d: payload.d,
      s: payload.s ?? null,
    });
  }

  private identifyOrResume(): void {
    if (this.sessionId && this.sequence !== null) {
      this.send({
        op: discordOpcode.resume,
        d: { token: this.options.token, session_id: this.sessionId, seq: this.sequence },
      });
      return;
    }
    this.send({
      op: discordOpcode.identify,
      d: {
        token: this.options.token,
        intents: discordGatewayIntents,
        properties: { os: process.platform, browser: "coworker", device: "coworker" },
      },
    });
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ op: discordOpcode.heartbeat, d: this.sequence });
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private send(payload: unknown): void {
    if (!this.socket || this.socket.readyState !== 1) return;
    try {
      this.socket.send(JSON.stringify(payload));
    } catch (error) {
      this.options.handlers.onError?.("discord.gateway", error);
    }
  }

  private teardownSocket(code: number, reason: string): void {
    this.clearHeartbeat();
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try {
      socket.close(code, reason);
    } catch {
      // Already closing.
    }
  }
}

export function isDiscordMessage(value: unknown): value is DiscordMessage {
  return Boolean(value && typeof value === "object" && typeof (value as DiscordMessage).id === "string");
}

export function isDiscordChannel(value: unknown): value is DiscordChannel {
  return Boolean(
    value && typeof value === "object" && typeof (value as DiscordChannel).id === "string",
  );
}

export function isDiscordInteraction(value: unknown): value is DiscordInteraction {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as DiscordInteraction).id === "string" &&
      typeof (value as DiscordInteraction).token === "string",
  );
}
