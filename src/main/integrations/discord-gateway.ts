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

/** Close codes Discord documents as non-resumable / do-not-reconnect. */
export const discordFatalCloseCodes = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

export function discordGatewayErrorHint(code: number): string {
  if (code === 4004) return "Discord rejected the bot token.";
  if (code === 4014) {
    return "Discord closed the connection because Message Content Intent is off. Turn it on in the Developer Portal, then reconnect.";
  }
  if (code === 4013) return "Discord rejected the Gateway intents. Check Privileged Gateway Intents in the Developer Portal.";
  if (code === 4010 || code === 4011 || code === 4012) {
    return `Discord closed the Gateway (code ${code}) and will not accept a reconnect until the bot is reconfigured.`;
  }
  return `Discord closed the Gateway (code ${code}).`;
}

export class DiscordFatalCloseError extends Error {
  constructor(
    readonly code: number,
    readonly hint: string,
  ) {
    super(hint);
    this.name = "DiscordFatalCloseError";
  }
}

export class DiscordInvalidSessionError extends Error {
  constructor() {
    super("Discord session is not resumable");
    this.name = "DiscordInvalidSessionError";
  }
}

export class DiscordReconnectError extends Error {
  constructor(readonly code: number) {
    super(`Discord Gateway closed (${code})`);
    this.name = "DiscordReconnectError";
  }
}

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
  onFatal?: (code: number, hint: string) => void;
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
  resumeUrl?: string | null;
  /** How long a requested close may take before the socket is force-terminated. */
  closeTimeoutMs?: number;
}

const maxBackoffMs = 60_000;
const minReconnectMs = 1_000;
const invalidSessionMinMs = 1_000;
const invalidSessionMaxMs = 5_000;
export const discordDefaultCloseTimeoutMs = 5_000;
/** Client close that keeps the session resumable. Discord invalidates 1000/1001. */
export const discordResumableCloseCode = 4000;

/**
 * One Gateway WebSocket plus the state needed to finish it exactly once. A
 * dead peer never answers the close handshake, so a close may be completed
 * by the timeout in `teardownSocket` rather than by the socket's own event.
 */
interface GatewayConnection {
  socket: WebSocket;
  closed: boolean;
  closeTimer: ReturnType<typeof setTimeout> | null;
  onClosed: (code: number, reason: string) => void;
}

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
 *
 * Discord allows concurrent Gateway sessions per bot. A second Coworker with
 * the same token is not kicked (4005/4010 are not a multi-instance signal);
 * both processes receive MESSAGE_CREATE and may inject/reply. Avoid running
 * two connected instances against one bot until an out-of-band lock exists.
 */
export class DiscordGateway {
  private connection: GatewayConnection | null = null;
  private running = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatStartTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatIntervalMs = 41_250;
  private awaitingHeartbeatAck = false;
  private sequence: number | null;
  private sessionId: string | null;
  private resumeUrl: string | null;
  private identified = false;
  private expectInvalidSession = false;
  private connectLoop: Promise<void> = Promise.resolve();
  private abort: AbortController | null = null;
  private backoffMs = minReconnectMs;

  constructor(private readonly options: DiscordGatewayOptions) {
    this.sequence = options.lastSequence ?? null;
    this.sessionId = options.sessionId ?? null;
    this.resumeUrl = options.resumeUrl ?? null;
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
    this.clearSession();
    this.teardownSocket(1000, "stopped");
    await this.connectLoop.catch(() => undefined);
  }

  /** Close with a resumable code and reconnect (OS resume / reconfigure). */
  async wake(): Promise<void> {
    if (!this.running) {
      await this.start();
      return;
    }
    this.teardownSocket(discordResumableCloseCode, "wake");
  }

  private clearSession(): void {
    this.sessionId = null;
    this.sequence = null;
    this.resumeUrl = null;
    this.options.handlers.onSequence?.(null, null);
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const signal = this.abort?.signal;
      try {
        await this.connectOnce();
        if (!this.running || signal?.aborted) return;
        await delay(minReconnectMs, signal);
        this.backoffMs = minReconnectMs;
      } catch (error) {
        if (!this.running || signal?.aborted) return;
        if (error instanceof DiscordFatalCloseError) {
          this.running = false;
          this.options.handlers.onFatal?.(error.code, error.hint);
          return;
        }
        this.options.handlers.onError?.("discord.gateway", error);
        if (error instanceof DiscordInvalidSessionError) {
          const wait =
            invalidSessionMinMs +
            Math.floor(Math.random() * (invalidSessionMaxMs - invalidSessionMinMs));
          await delay(wait, signal);
          this.backoffMs = minReconnectMs;
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
      const connection: GatewayConnection = {
        socket,
        closed: false,
        closeTimer: null,
        onClosed: (code, reason) => {
          if (connection.closed) return;
          connection.closed = true;
          if (connection.closeTimer) {
            clearTimeout(connection.closeTimer);
            connection.closeTimer = null;
          }
          if (this.connection === connection) {
            this.clearHeartbeat();
            this.connection = null;
          }
          this.options.handlers.onClose?.(code, reason);
          if (discordFatalCloseCodes.has(code)) {
            finish(new DiscordFatalCloseError(code, discordGatewayErrorHint(code)));
            return;
          }
          if (this.expectInvalidSession) {
            this.expectInvalidSession = false;
            finish(new DiscordInvalidSessionError());
            return;
          }
          if (code !== 1000 && code !== 1001 && code !== discordResumableCloseCode) {
            finish(new DiscordReconnectError(code));
            return;
          }
          finish();
        },
      };
      this.connection = connection;
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
        if (connection.closed) return;
        void this.handlePayload(String((event as MessageEvent).data)).catch((error) => {
          this.options.handlers.onError?.("discord.gateway", error);
        });
      });
      socket.addEventListener("error", () => {
        // close follows; avoid leaking token-bearing URLs from the event.
      });
      socket.addEventListener("close", (event) => {
        const close = event as CloseEvent;
        connection.onClosed(close.code, close.reason ?? "");
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
    if (payload.op === discordOpcode.heartbeatAck) {
      this.awaitingHeartbeatAck = false;
      return;
    }
    if (payload.op === discordOpcode.reconnect) {
      this.teardownSocket(discordResumableCloseCode, "reconnect");
      return;
    }
    if (payload.op === discordOpcode.invalidSession) {
      const resumable = payload.d === true;
      if (!resumable) {
        this.clearSession();
        this.expectInvalidSession = true;
      }
      this.teardownSocket(discordResumableCloseCode, "invalid session");
      return;
    }
    if (payload.op !== discordOpcode.dispatch || !payload.t) return;

    if (payload.t === "READY") {
      const ready = payload.d as { session_id?: string; resume_gateway_url?: string };
      this.sessionId = ready.session_id ?? this.sessionId;
      this.resumeUrl = ready.resume_gateway_url ?? this.resumeUrl;
      this.identified = true;
      this.backoffMs = minReconnectMs;
      this.options.handlers.onSequence?.(this.sequence, this.sessionId);
      this.options.handlers.onReady?.(this.sessionId ?? "", this.resumeUrl ?? undefined);
    }
    if (payload.t === "RESUMED") {
      this.identified = true;
      this.backoffMs = minReconnectMs;
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
    this.awaitingHeartbeatAck = false;
    const jitter = Math.random();
    this.heartbeatStartTimer = setTimeout(() => {
      this.heartbeatStartTimer = null;
      this.beat();
      this.heartbeatTimer = setInterval(() => this.beat(), this.heartbeatIntervalMs);
      this.heartbeatTimer.unref?.();
    }, Math.max(1, this.heartbeatIntervalMs * jitter));
    this.heartbeatStartTimer.unref?.();
  }

  private beat(): void {
    if (this.awaitingHeartbeatAck) {
      this.teardownSocket(discordResumableCloseCode, "heartbeat ack missing");
      return;
    }
    this.awaitingHeartbeatAck = true;
    this.send({ op: discordOpcode.heartbeat, d: this.sequence });
  }

  private clearHeartbeat(): void {
    if (this.heartbeatStartTimer) {
      clearTimeout(this.heartbeatStartTimer);
      this.heartbeatStartTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.awaitingHeartbeatAck = false;
  }

  private send(payload: unknown): void {
    const socket = this.connection?.socket;
    if (!socket || socket.readyState !== 1) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch (error) {
      this.options.handlers.onError?.("discord.gateway", error);
    }
  }

  /**
   * Ask the peer to close, then guarantee the connection finishes: a dead TCP
   * peer (the case behind missed heartbeat ACKs) never completes the close
   * handshake, which used to leave a zombie socket and the bot offline until
   * the process restarted. After `closeTimeoutMs` the socket is terminated
   * and the close is completed locally so the loop reconnects.
   */
  private teardownSocket(code: number, reason: string): void {
    this.clearHeartbeat();
    const connection = this.connection;
    this.connection = null;
    if (!connection || connection.closed) return;
    try {
      connection.socket.close(code, reason);
    } catch {
      // Already closing.
    }
    if (connection.closed) return;
    const timeoutMs = this.options.closeTimeoutMs ?? discordDefaultCloseTimeoutMs;
    connection.closeTimer = setTimeout(() => {
      connection.closeTimer = null;
      if (connection.closed) return;
      this.options.handlers.onError?.(
        "discord.gateway",
        new Error(
          `Discord Gateway close (${code}: ${reason}) was not acknowledged within ${timeoutMs} ms; terminating the socket`,
        ),
      );
      try {
        (connection.socket as { terminate?: () => void }).terminate?.();
      } catch {
        // Nothing left to release.
      }
      connection.onClosed(code, reason);
    }, timeoutMs);
    connection.closeTimer.unref?.();
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
