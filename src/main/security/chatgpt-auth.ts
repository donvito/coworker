import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createLocalJWKSet, errors as joseErrors, jwtVerify, type JSONWebKeySet } from "jose";
import type { ChatGPTAccount, ChatGPTAuthStatus, OpenAIAuthMode } from "@shared/chatgpt-auth";
import { CredentialDecryptionError, type CredentialStore } from "@main/security/credential-store";

const AUTH_ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${AUTH_ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${AUTH_ISSUER}/api/accounts/oauth/token`;
const DISCOVERY_URL = `${AUTH_ISSUER}/.well-known/openid-configuration`;
const RESOURCE = "https://api.openai.com/v1";
const CREDENTIAL_KEY = "model:openai:chatgpt";
const INITIAL_CLIENT_ID = "dynamic_agent_client";
const REDIRECT_PATH = "/auth/callback";
const REQUESTED_SCOPES = [
  "openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct",
].join(" ");
const DIRECT_USAGE_SCOPE = "chatgpt.tokens.use.direct";
const INFERENCE_SCOPE = "resource.invoke";
const REFRESH_EARLY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const CALLBACK_TIMEOUT_MS = 5 * 60_000;
const JWKS_CACHE_TTL_MS = 15 * 60_000;
const UNUSABLE_REFRESH_CODES = new Set([
  "invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired",
  "refresh_token_invalidated", "refresh_token_reused",
]);

export interface ChatGPTAuthServiceOptions {
  credentials: CredentialStore;
  openExternal: (url: string) => Promise<void>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Allows deterministic timeout coverage without waiting for the production window. */
  callbackTimeoutMs?: number;
  /** Stop workers before replacing or removing the active ChatGPT session. */
  beforeChange?: () => Promise<void>;
  /** Recover workers after an active-session mutation, including failed writes. */
  afterChange?: () => Promise<void>;
}

interface StoredAccount {
  id: string;
  clientId: string;
  subject: string;
  label: string;
  email?: string;
  idToken?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  earliestRefreshAt?: number;
  scopes: string[];
}

interface StoredAuth {
  schema: 1;
  hostId: string;
  mode: OpenAIAuthMode;
  activeAccountId: string | null;
  welcomeSeen: boolean;
  accounts: StoredAccount[];
}

interface OpenIdConfiguration {
  issuer: string;
  jwks_uri: string;
  revocation_endpoint: string;
}

interface VerifiedIdentity {
  subject: string;
  email?: string;
  name?: string;
}

interface OAuthCallback {
  code?: string;
  error?: string;
  clientId?: string;
}

interface PendingSignIn {
  generation: number;
  cancelled: boolean;
  controller: AbortController;
  cancelPromise: Promise<never>;
  rejectCancelled: () => void;
  state: string;
  nonce: string;
  verifier: string;
  requestedClientId?: string;
  callbackServer?: Server;
  redirectUri?: string;
  callbackPromise?: Promise<OAuthCallback>;
  callbackTimeout?: ReturnType<typeof setTimeout>;
  done?: Promise<void>;
}

class ChatGPTAuthError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "ChatGPTAuthError";
  }
}

class OAuthResponseError extends Error {
  constructor(readonly oauthCode: string | null, readonly status: number) {
    super("OAuth request failed");
    this.name = "OAuthResponseError";
  }
}

class RequestTimedOut extends Error {}
class SignInCancelled extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseScopes(value: unknown): string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return [...new Set(value as string[])];
  }
  if (typeof value === "string") return [...new Set(value.split(/\s+/).filter(Boolean))];
  return [];
}

function tokenConnected(account: StoredAccount, now: number): boolean {
  return Boolean(account.refreshToken || (account.accessToken && account.expiresAt && account.expiresAt > now));
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== "string" || !value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizedStoredAuth(value: unknown): StoredAuth | null {
  if (!isRecord(value) || value.schema !== 1 || typeof value.hostId !== "string" ||
      !value.hostId.startsWith("urn:uuid:") ||
      (value.mode !== "api-key" && value.mode !== "chatgpt-subscription") ||
      !(value.activeAccountId === null || typeof value.activeAccountId === "string") ||
      typeof value.welcomeSeen !== "boolean" || !Array.isArray(value.accounts)) return null;

  const accounts: StoredAccount[] = [];
  for (const raw of value.accounts) {
    if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.clientId !== "string" ||
        raw.clientId === INITIAL_CLIENT_ID || typeof raw.subject !== "string" ||
        typeof raw.label !== "string") return null;
    accounts.push({
      id: raw.id,
      clientId: raw.clientId,
      subject: raw.subject,
      label: raw.label,
      ...(typeof raw.email === "string" ? { email: raw.email } : {}),
      ...(typeof raw.idToken === "string" ? { idToken: raw.idToken } : {}),
      ...(typeof raw.accessToken === "string" ? { accessToken: raw.accessToken } : {}),
      ...(typeof raw.refreshToken === "string" ? { refreshToken: raw.refreshToken } : {}),
      ...(typeof raw.expiresAt === "number" ? { expiresAt: raw.expiresAt } : {}),
      ...(typeof raw.earliestRefreshAt === "number" ? { earliestRefreshAt: raw.earliestRefreshAt } : {}),
      scopes: parseScopes(raw.scopes),
    });
  }
  return {
    schema: 1,
    hostId: value.hostId,
    mode: value.mode,
    activeAccountId: value.activeAccountId,
    welcomeSeen: value.welcomeSeen,
    accounts,
  };
}

function freshStoredAuth(): StoredAuth {
  return {
    schema: 1,
    hostId: `urn:uuid:${randomUUID()}`,
    mode: "api-key",
    activeAccountId: null,
    welcomeSeen: false,
    accounts: [],
  };
}

function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function urlSafeStateEquals(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function safeHtml(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Coworker</title></head><body><p>${message}</p><p>You can close this window and return to Coworker.</p></body></html>`;
}

function displayAccount(account: StoredAccount, now: number): ChatGPTAccount {
  return {
    id: account.id,
    label: account.label,
    ...(account.email ? { email: account.email } : {}),
    connected: tokenConnected(account, now),
    planUsageEnabled: tokenConnected(account, now) &&
      account.scopes.includes(DIRECT_USAGE_SCOPE) && account.scopes.includes(INFERENCE_SCOPE),
  };
}

function clearTokens(account: StoredAccount): StoredAccount {
  const { idToken: _idToken, accessToken: _accessToken, refreshToken: _refreshToken,
    expiresAt: _expiresAt, earliestRefreshAt: _earliestRefreshAt, ...identity } = account;
  return { ...identity, scopes: [] };
}

function callbackParams(url: URL): Map<string, string> | null {
  const values = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    if (values.has(key)) return null;
    values.set(key, value);
  }
  return values;
}

/** Owns the OAuth listener, token lifecycle, and encrypted ChatGPT account records. */
export class ChatGPTAuthService {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private statePromise: Promise<StoredAuth> | null = null;
  private state: StoredAuth | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private transitionTail: Promise<void> = Promise.resolve();
  private activeAttempt: PendingSignIn | null = null;
  private retryClientId: string | null = null;
  private recoveryRequired = false;
  private generation = 0;
  private discoveryPromise: Promise<OpenIdConfiguration> | null = null;
  private jwksLoadPromise: Promise<ReturnType<typeof createLocalJWKSet>> | null = null;
  private jwksExpiresAt = 0;

  constructor(private readonly options: ChatGPTAuthServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** Exposes only account metadata and the current auth state. */
  async status(): Promise<ChatGPTAuthStatus> {
    const state = await this.loadState();
    const now = this.now();
    const active = state.accounts.find((account) => account.id === state.activeAccountId);
    const authState: ChatGPTAuthStatus["state"] = this.activeAttempt
      ? "waiting"
      : this.recoveryRequired
        ? "sign-in-required"
      : !state.activeAccountId || !active
        ? "disconnected"
        : tokenConnected(active, now)
          ? "connected"
          : "sign-in-required";
    return {
      mode: state.mode,
      state: authState,
      activeAccountId: state.activeAccountId,
      accounts: state.accounts.map((account) => displayAccount(account, now)),
      welcomeSeen: state.welcomeSeen,
    };
  }

  /** Starts a fresh dynamic registration or reauthorizes a saved registration. */
  async startSignIn(accountId?: string): Promise<ChatGPTAuthStatus> {
    if (this.activeAttempt) throw new ChatGPTAuthError("A ChatGPT sign-in is already in progress.", "SIGN_IN_IN_PROGRESS");
    let rejectCancelled!: (error: Error) => void;
    const cancelPromise = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
    const attempt: PendingSignIn = {
      generation: ++this.generation,
      cancelled: false,
      controller: new AbortController(),
      cancelPromise,
      rejectCancelled: () => rejectCancelled(new SignInCancelled("Sign-in cancelled")),
      state: randomSecret(),
      nonce: randomSecret(),
      verifier: randomSecret(48),
    };
    void attempt.cancelPromise.catch(() => undefined);
    this.activeAttempt = attempt;

    const flow = this.runSignIn(attempt, accountId);
    attempt.done = flow.then(() => undefined, () => undefined);
    try {
      return await flow;
    } finally {
      if (this.activeAttempt === attempt) this.activeAttempt = null;
      if (attempt.callbackTimeout) clearTimeout(attempt.callbackTimeout);
      await this.closeCallbackServer(attempt.callbackServer);
    }
  }

  private async runSignIn(attempt: PendingSignIn, accountId?: string): Promise<ChatGPTAuthStatus> {
    let selected: StoredAccount | undefined;
    let registrationClientId: string | undefined;
    try {
      const state = await this.loadState();
      if (attempt.cancelled) throw new SignInCancelled("Sign-in cancelled");
      selected = accountId ? state.accounts.find((account) => account.id === accountId) : undefined;
      if (accountId && !selected) throw new ChatGPTAuthError("That ChatGPT account is no longer available.", "ACCOUNT_NOT_FOUND");
      if (!selected && this.retryClientId) attempt.requestedClientId = this.retryClientId;
      await this.persistIfMissing(state);
      if (attempt.cancelled) throw new SignInCancelled("Sign-in cancelled");
      const { callbackServer, redirectUri } = await this.listenForCallback(attempt);
      attempt.callbackServer = callbackServer;
      attempt.redirectUri = redirectUri;
      if (attempt.cancelled) throw new SignInCancelled("Sign-in cancelled");

      const clientId = selected?.clientId ?? attempt.requestedClientId ?? INITIAL_CLIENT_ID;
      const challenge = createHash("sha256").update(attempt.verifier).digest("base64url");
      const authorize = new URL(AUTHORIZE_URL);
      authorize.searchParams.set("client_id", clientId);
      if (!selected && !attempt.requestedClientId) authorize.searchParams.set("agent_name_hint", "Coworker");
      authorize.searchParams.set("ext_agent_host_id", (await this.loadState()).hostId);
      if (selected?.idToken) authorize.searchParams.set("id_token_hint", selected.idToken);
      if (selected?.email) authorize.searchParams.set("login_hint", selected.email);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("redirect_uri", redirectUri);
      authorize.searchParams.set("scope", REQUESTED_SCOPES);
      authorize.searchParams.set("resource", RESOURCE);
      authorize.searchParams.set("state", attempt.state);
      authorize.searchParams.set("nonce", attempt.nonce);
      authorize.searchParams.set("code_challenge_method", "S256");
      authorize.searchParams.set("code_challenge", challenge);

      const callbackTimeout = new Promise<never>((_resolve, reject) => {
        attempt.callbackTimeout = setTimeout(
          () => reject(new RequestTimedOut()),
          this.options.callbackTimeoutMs ?? CALLBACK_TIMEOUT_MS,
        );
      });
      void callbackTimeout.catch(() => undefined);

      await Promise.race([
        this.options.openExternal(authorize.toString()),
        attempt.cancelPromise,
        callbackTimeout,
      ]);
      const callback = await Promise.race([
        this.callbackResult(callbackServer, attempt),
        attempt.cancelPromise,
        callbackTimeout,
      ]);
      if (attempt.callbackTimeout) {
        clearTimeout(attempt.callbackTimeout);
        attempt.callbackTimeout = undefined;
      }
      if (attempt.cancelled || attempt.generation !== this.generation) throw new SignInCancelled("Sign-in cancelled");
      if (callback.error) throw new ChatGPTAuthError("Sign-in was cancelled or could not be completed.", "OAUTH_DENIED");
      if (!callback.code) throw new ChatGPTAuthError("The ChatGPT sign-in response was incomplete.", "INVALID_CALLBACK");

      const issuedClientId = selected?.clientId ?? attempt.requestedClientId ?? callback.clientId;
      registrationClientId = issuedClientId;
      if (!issuedClientId || issuedClientId === INITIAL_CLIENT_ID) {
        throw new ChatGPTAuthError("ChatGPT did not finish registering this app.", "MISSING_ISSUED_CLIENT_ID");
      }
      if (selected && callback.clientId && callback.clientId !== selected.clientId) {
        throw new ChatGPTAuthError("ChatGPT returned a different account registration.", "CLIENT_MISMATCH");
      }
      if (attempt.requestedClientId && callback.clientId && callback.clientId !== attempt.requestedClientId) {
        throw new ChatGPTAuthError("ChatGPT returned a different account registration.", "CLIENT_MISMATCH");
      }
      const tokenResponse = await this.postForm(TOKEN_URL, {
        grant_type: "authorization_code",
        client_id: issuedClientId,
        code: callback.code,
        code_verifier: attempt.verifier,
        redirect_uri: redirectUri,
        resource: RESOURCE,
      }, attempt.controller.signal);
      if (attempt.cancelled || attempt.generation !== this.generation) throw new SignInCancelled("Sign-in cancelled");
      if (tokenResponse.client_id && tokenResponse.client_id !== issuedClientId) {
        throw new ChatGPTAuthError("ChatGPT returned a different account registration.", "CLIENT_MISMATCH");
      }
      const idToken = nonemptyString(tokenResponse.id_token);
      if (!idToken) throw new ChatGPTAuthError("ChatGPT could not verify the signed-in account.", "INVALID_ID_TOKEN");
      const identity = await Promise.race([
        this.verifyIdentity(idToken, issuedClientId, attempt.nonce, selected?.subject, attempt.controller.signal),
        attempt.cancelPromise,
      ]);
      const candidate = this.accountFromResponse(tokenResponse, issuedClientId, identity);
      if (attempt.cancelled || attempt.generation !== this.generation) throw new SignInCancelled("Sign-in cancelled");

      await this.withTransition(() => this.withMutation(async (current) => {
        if (attempt.cancelled || attempt.generation !== this.generation) throw new SignInCancelled("Sign-in cancelled");
        const existing = current.accounts.find((account) => account.clientId === issuedClientId && account.subject === identity.subject);
        if (selected && (!existing || existing.id !== selected.id)) {
          throw new ChatGPTAuthError("The verified account did not match the selected ChatGPT account.", "ACCOUNT_MISMATCH");
        }
        const nextAccount: StoredAccount = existing
          ? { ...existing, ...candidate, id: existing.id, label: existing.label }
          : { ...candidate, id: randomUUID(), label: this.uniqueLabel(current.accounts, identity) };
        const next: StoredAuth = {
          ...current,
          activeAccountId: nextAccount.id,
          accounts: existing
            ? current.accounts.map((account) => account.id === existing.id ? nextAccount : account)
            : [...current.accounts, nextAccount],
        };
      await this.persist(next, true);
      }));
      if (!selected && this.retryClientId === issuedClientId) this.retryClientId = null;
      if (this.activeAttempt === attempt) this.activeAttempt = null;
      return await this.status();
    } catch (error) {
      if (error instanceof SignInCancelled || attempt.cancelled) {
        throw new ChatGPTAuthError("ChatGPT sign-in was cancelled.", "SIGN_IN_CANCELLED");
      }
      if (error instanceof ChatGPTAuthError) throw error;
      if (error instanceof OAuthResponseError) {
        if (error.oauthCode === "invalid_grant" && !selected && registrationClientId && registrationClientId !== INITIAL_CLIENT_ID) {
          // The authorization code is single-use; retry authorization against
          // the issued registration returned with the expired code.
          this.retryClientId = registrationClientId;
        }
        throw this.authErrorForOAuth(error, "sign-in");
      }
      if (error instanceof RequestTimedOut) throw new ChatGPTAuthError("ChatGPT sign-in took too long. Try again.", "REQUEST_TIMEOUT");
      if (error instanceof TypeError || error instanceof DOMException) {
        throw new ChatGPTAuthError("ChatGPT could not be reached. Check your connection and try again.", "NETWORK_ERROR");
      }
      throw new ChatGPTAuthError("ChatGPT sign-in could not be completed.", "SIGN_IN_FAILED");
    }
  }

  /** Cancels the listener, browser wait, or in-flight token request. */
  async cancelSignIn(): Promise<void> {
    const attempt = this.activeAttempt;
    if (!attempt) return;
    attempt.cancelled = true;
    this.generation++;
    attempt.controller.abort();
    attempt.rejectCancelled();
    await this.closeCallbackServer(attempt.callbackServer);
    await attempt.done;
  }

  async setMode(mode: OpenAIAuthMode): Promise<void> {
    if (mode !== "api-key" && mode !== "chatgpt-subscription") {
      throw new ChatGPTAuthError("Choose a supported OpenAI sign-in method.", "INVALID_MODE");
    }
    await this.withTransition(() => this.withMutation(async (state) => {
      if (state.mode !== mode) await this.persist({ ...state, mode });
    }));
  }

  async selectAccount(id: string): Promise<void> {
    await this.withTransition(() => this.withMutation(async (state) => {
      if (state.activeAccountId === id) return;
      const account = state.accounts.find((item) => item.id === id);
      if (!account) throw new ChatGPTAuthError("That ChatGPT account is no longer available.", "ACCOUNT_NOT_FOUND");
      if (!tokenConnected(account, this.now())) {
        throw new ChatGPTAuthError("Sign in to this ChatGPT account before selecting it.", "SIGN_IN_REQUIRED");
      }
      await this.persist({ ...state, activeAccountId: id });
    }));
  }

  async disconnect(): Promise<{ revocationConfirmed: boolean }> {
    const initial = await this.loadState();
    if (!initial.accounts.some((account) => account.id === initial.activeAccountId)) return { revocationConfirmed: true };
    return this.withTransition(() => this.withMutation(async (state) => {
      const selected = state.accounts.find((account) => account.id === state.activeAccountId);
      if (!selected) return { revocationConfirmed: true };
      const hasRemoteSession = Boolean(selected.refreshToken);
      let revocationConfirmed = !hasRemoteSession;
      {
        if (hasRemoteSession && selected.refreshToken) {
          try {
            const configuration = await this.openIdConfiguration(undefined);
            const endpoint = new URL(configuration.revocation_endpoint);
            const first = await this.revoke(endpoint.toString(), selected);
            if (first) revocationConfirmed = true;
            else {
              await new Promise((resolve) => setTimeout(resolve, 250));
              revocationConfirmed = await this.revoke(endpoint.toString(), selected);
            }
          } catch {
            // A failed remote revoke never retains local credentials after sign-out.
            revocationConfirmed = false;
          }
        }
      await this.persist({
        ...state,
        activeAccountId: null,
        accounts: state.accounts.map((account) => account.id === selected.id ? clearTokens(account) : account),
      });
      }
      return { revocationConfirmed };
    }));
  }

  async acknowledgeWelcome(): Promise<void> {
    await this.withMutation(async (state) => {
      if (state.welcomeSeen) return;
      await this.persist({ ...state, welcomeSeen: true });
    });
  }

  /** Returns a token only when subscription mode and the direct-use scope are active. */
  async getAccessToken(expectedAccountId?: string): Promise<string> {
    const initial = await this.loadState();
    const active = this.selectedAccount(initial, expectedAccountId);
    if (initial.mode !== "chatgpt-subscription") {
      throw new ChatGPTAuthError("ChatGPT subscription sign-in is not selected.", "AUTH_MODE_NOT_SELECTED");
    }
    this.ensureDirectUsage(active);
    if (!active.accessToken || !active.expiresAt) {
      return this.refreshAccessToken(active.id);
    }
    const now = this.now();
    const isNearExpiry = active.expiresAt <= now + REFRESH_EARLY_MS;
    const heldByProvider = active.earliestRefreshAt !== undefined && now < active.earliestRefreshAt;
    if (!isNearExpiry || (heldByProvider && active.expiresAt > now)) return active.accessToken;
    return this.refreshAccessToken(active.id);
  }

  private async refreshAccessToken(accountId: string): Promise<string> {
    return this.withMutation(async (state) => {
      if (state.mode !== "chatgpt-subscription") {
        throw new ChatGPTAuthError("ChatGPT subscription sign-in is not selected.", "AUTH_MODE_NOT_SELECTED");
      }
      const account = state.accounts.find((item) => item.id === accountId);
      if (!account || state.activeAccountId !== accountId) {
        throw new ChatGPTAuthError("Sign in to the selected ChatGPT account again.", "SIGN_IN_REQUIRED");
      }
      this.ensureDirectUsage(account);
      const now = this.now();
      if (account.accessToken && account.expiresAt && account.expiresAt > now + REFRESH_EARLY_MS) return account.accessToken;
      if (account.earliestRefreshAt !== undefined && now < account.earliestRefreshAt && account.accessToken && account.expiresAt! > now) {
        return account.accessToken;
      }
      if (!account.refreshToken) {
        if (account.accessToken && account.expiresAt && account.expiresAt > now) return account.accessToken;
        throw new ChatGPTAuthError("Sign in to the selected ChatGPT account again.", "SIGN_IN_REQUIRED");
      }

      let response: Record<string, unknown>;
      try {
        response = await this.postForm(TOKEN_URL, {
          grant_type: "refresh_token",
          client_id: account.clientId,
          refresh_token: account.refreshToken,
          resource: RESOURCE,
        });
      } catch (error) {
        if (error instanceof OAuthResponseError && error.oauthCode && UNUSABLE_REFRESH_CODES.has(error.oauthCode)) {
          await this.persist({
            ...state,
            accounts: state.accounts.map((item) => item.id === account.id ? clearTokens(item) : item),
          });
          throw new ChatGPTAuthError("Sign in to the selected ChatGPT account again.", "SIGN_IN_REQUIRED");
        }
        if (error instanceof OAuthResponseError) throw this.authErrorForOAuth(error, "refresh");
        if (error instanceof RequestTimedOut) throw new ChatGPTAuthError("ChatGPT is taking too long to respond. Try again.", "REQUEST_TIMEOUT");
        throw new ChatGPTAuthError("ChatGPT could not be reached. Your saved sign-in is still available.", "NETWORK_ERROR");
      }

      if (response.client_id && response.client_id !== account.clientId) {
        throw new ChatGPTAuthError("ChatGPT returned a different account registration.", "CLIENT_MISMATCH");
      }
      const returnedIdToken = nonemptyString(response.id_token);
      let refreshedIdentity: VerifiedIdentity | undefined;
      if (returnedIdToken) refreshedIdentity = await this.verifyIdentity(returnedIdToken, account.clientId, undefined, account.subject);
      const replacement = this.accountFromResponse(response, account.clientId, {
        subject: refreshedIdentity?.subject ?? account.subject,
        ...(refreshedIdentity?.email ?? account.email ? { email: refreshedIdentity?.email ?? account.email } : {}),
      });
      const nextAccount: StoredAccount = {
        ...account,
        accessToken: replacement.accessToken,
        refreshToken: replacement.refreshToken ?? account.refreshToken,
        idToken: returnedIdToken ?? account.idToken,
        expiresAt: replacement.expiresAt,
        earliestRefreshAt: replacement.earliestRefreshAt,
        scopes: Object.hasOwn(response, "scope") ? replacement.scopes : account.scopes,
        ...(refreshedIdentity?.email ? { email: refreshedIdentity.email } : {}),
      };
      await this.persist({
        ...state,
        accounts: state.accounts.map((item) => item.id === account.id ? nextAccount : item),
      });
      this.ensureDirectUsage(nextAccount);
      return nextAccount.accessToken!;
    });
  }

  private selectedAccount(state: StoredAuth, expectedAccountId?: string): StoredAccount {
    const account = state.accounts.find((item) => item.id === state.activeAccountId);
    if (!account || (expectedAccountId && expectedAccountId !== state.activeAccountId)) {
      throw new ChatGPTAuthError("Sign in to the selected ChatGPT account.", "SIGN_IN_REQUIRED");
    }
    return account;
  }

  private ensureDirectUsage(account: StoredAccount): void {
    if (!tokenConnected(account, this.now())) {
      throw new ChatGPTAuthError("Sign in to the selected ChatGPT account again.", "SIGN_IN_REQUIRED");
    }
    if (!account.scopes.includes(DIRECT_USAGE_SCOPE) || !account.scopes.includes(INFERENCE_SCOPE)) {
      throw new ChatGPTAuthError("ChatGPT plan usage has not been approved for this account.", "PLAN_USAGE_NOT_AUTHORIZED");
    }
  }

  private accountFromResponse(
    response: Record<string, unknown>,
    clientId: string,
    identity: VerifiedIdentity,
  ): Omit<StoredAccount, "id" | "label"> {
    const accessToken = nonemptyString(response.access_token);
    const tokenType = nonemptyString(response.token_type);
    const expiresIn = typeof response.expires_in === "number" ? response.expires_in : Number(response.expires_in);
    if (!accessToken || tokenType?.toLowerCase() !== "bearer" || !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 31 * 24 * 60 * 60) {
      throw new ChatGPTAuthError("ChatGPT returned an incomplete sign-in response.", "INVALID_TOKEN_RESPONSE");
    }
    const refreshToken = nonemptyString(response.refresh_token);
    const idToken = nonemptyString(response.id_token);
    return {
      clientId,
      subject: identity.subject,
      ...(identity.email ? { email: identity.email } : {}),
      ...(idToken ? { idToken } : {}),
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      expiresAt: this.now() + expiresIn * 1000,
      ...(parseTimestamp(response.earliest_refresh_at) !== undefined
        ? { earliestRefreshAt: parseTimestamp(response.earliest_refresh_at) }
        : {}),
      scopes: parseScopes(response.scope),
    };
  }

  private uniqueLabel(accounts: StoredAccount[], identity: VerifiedIdentity): string {
    const base = identity.name?.trim() || identity.email?.trim() || "ChatGPT account";
    const collisionCount = accounts.filter((account) => account.label === base || account.label.startsWith(`${base} ·`)).length;
    return collisionCount === 0 ? base : `${base} · ${collisionCount + 1}`;
  }

  private async localJwks(signal?: AbortSignal, forceRefresh = false): Promise<ReturnType<typeof createLocalJWKSet>> {
    if (forceRefresh || (this.jwksLoadPromise && this.jwksExpiresAt > 0 && this.now() >= this.jwksExpiresAt)) {
      this.jwksLoadPromise = null;
      this.jwksExpiresAt = 0;
    }
    if (!this.jwksLoadPromise) {
      this.jwksExpiresAt = Number.POSITIVE_INFINITY;
      let loading!: Promise<ReturnType<typeof createLocalJWKSet>>;
      loading = (async () => {
        const configuration = await this.openIdConfiguration(signal);
        const response = await this.request(configuration.jwks_uri, { method: "GET" }, signal);
        if (!response.ok) throw new ChatGPTAuthError("ChatGPT could not verify the signed-in account.", "JWKS_UNAVAILABLE");
        const body: unknown = await response.json().catch(() => null);
        if (!isRecord(body) || !Array.isArray(body.keys) || body.keys.length === 0) {
          throw new ChatGPTAuthError("ChatGPT could not verify the signed-in account.", "JWKS_INVALID");
        }
        return createLocalJWKSet(body as unknown as JSONWebKeySet);
      })().then((keySet) => {
        if (this.jwksLoadPromise === loading) this.jwksExpiresAt = this.now() + JWKS_CACHE_TTL_MS;
        return keySet;
      }).catch((error) => {
        if (this.jwksLoadPromise === loading) {
          this.jwksLoadPromise = null;
          this.jwksExpiresAt = 0;
        }
        throw error;
      });
      this.jwksLoadPromise = loading;
    }
    return this.jwksLoadPromise;
  }

  private async openIdConfiguration(signal?: AbortSignal): Promise<OpenIdConfiguration> {
    if (!this.discoveryPromise) {
      this.discoveryPromise = (async () => {
        const response = await this.request(DISCOVERY_URL, { method: "GET" }, signal);
        if (!response.ok) throw new ChatGPTAuthError("ChatGPT could not verify the signed-in account.", "DISCOVERY_UNAVAILABLE");
        const body: unknown = await response.json().catch(() => null);
        if (!isRecord(body) || body.issuer !== AUTH_ISSUER ||
            typeof body.jwks_uri !== "string" || typeof body.revocation_endpoint !== "string") {
          throw new ChatGPTAuthError("ChatGPT returned invalid sign-in settings.", "DISCOVERY_INVALID");
        }
        const jwks = new URL(body.jwks_uri);
        const revocation = new URL(body.revocation_endpoint);
        if (jwks.protocol !== "https:" || jwks.origin !== AUTH_ISSUER ||
            revocation.protocol !== "https:" || revocation.origin !== AUTH_ISSUER) {
          throw new ChatGPTAuthError("ChatGPT returned invalid sign-in settings.", "DISCOVERY_INVALID");
        }
        return { issuer: AUTH_ISSUER, jwks_uri: jwks.toString(), revocation_endpoint: revocation.toString() };
      })().catch((error) => {
        this.discoveryPromise = null;
        throw error;
      });
    }
    return this.discoveryPromise;
  }

  private async verifyIdentity(
    token: string,
    clientId: string,
    nonce?: string,
    expectedSubject?: string,
    signal?: AbortSignal,
  ): Promise<VerifiedIdentity> {
    for (let keyAttempt = 0; keyAttempt < 2; keyAttempt++) {
      try {
        const keySet = await this.localJwks(signal, keyAttempt === 1);
        const verified = await jwtVerify(token, keySet, {
          issuer: AUTH_ISSUER,
          audience: clientId,
          algorithms: ["RS256", "ES256"],
          requiredClaims: ["exp", "iat", "sub"],
          currentDate: new Date(this.now()),
        });
        if (nonce && verified.payload.nonce !== nonce) throw new Error("Nonce mismatch");
        const subject = nonemptyString(verified.payload.sub);
        if (!subject || (expectedSubject && subject !== expectedSubject)) throw new Error("Identity mismatch");
        const email = nonemptyString(verified.payload.email);
        const name = nonemptyString(verified.payload.name);
        return { subject, ...(email ? { email } : {}), ...(name ? { name } : {}) };
      } catch (error) {
        if (keyAttempt === 0 && error instanceof joseErrors.JWKSNoMatchingKey) continue;
        throw new ChatGPTAuthError("ChatGPT could not verify the signed-in account.", "INVALID_ID_TOKEN");
      }
    }
    throw new ChatGPTAuthError("ChatGPT could not verify the signed-in account.", "INVALID_ID_TOKEN");
  }

  private async request(url: string, init: RequestInit, externalSignal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    externalSignal?.addEventListener("abort", forwardAbort, { once: true });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new RequestTimedOut());
      }, REQUEST_TIMEOUT_MS);
    });
    const abortPromise = externalSignal
      ? new Promise<never>((_resolve, reject) => {
          if (externalSignal.aborted) reject(new SignInCancelled("Sign-in cancelled"));
          else externalSignal.addEventListener("abort", () => reject(new SignInCancelled("Sign-in cancelled")), { once: true });
        })
      : new Promise<never>(() => undefined);
    try {
      const result = await Promise.race([
        this.fetchImpl(url, { ...init, signal: controller.signal }),
        timeoutPromise,
        abortPromise,
      ]);
      if (externalSignal?.aborted) throw new SignInCancelled("Sign-in cancelled");
      return result;
    } catch (error) {
      if (error instanceof RequestTimedOut || error instanceof SignInCancelled) throw error;
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", forwardAbort);
    }
  }

  private async postForm(url: string, values: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.request(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(values).toString(),
    }, signal);
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const oauthCode = isRecord(body) && typeof body.error === "string" ? body.error : null;
      throw new OAuthResponseError(oauthCode, response.status);
    }
    if (!isRecord(body)) throw new ChatGPTAuthError("ChatGPT returned an incomplete response.", "INVALID_TOKEN_RESPONSE");
    return body;
  }

  private authErrorForOAuth(error: OAuthResponseError, operation: "sign-in" | "refresh"): ChatGPTAuthError {
    if (error.oauthCode === "invalid_grant") {
      return new ChatGPTAuthError(
        operation === "sign-in" ? "This sign-in expired. Start again." : "Sign in to the selected ChatGPT account again.",
        operation === "sign-in" ? "AUTHORIZATION_EXPIRED" : "SIGN_IN_REQUIRED",
      );
    }
    if (error.oauthCode === "invalid_client") {
      return new ChatGPTAuthError("ChatGPT could not recognize this app registration.", "INVALID_CLIENT");
    }
    if (error.status >= 500 || error.status === 429) {
      return new ChatGPTAuthError("ChatGPT is temporarily unavailable. Try again.", "SERVICE_UNAVAILABLE");
    }
    return new ChatGPTAuthError("ChatGPT could not complete this request.", "OAUTH_REQUEST_FAILED");
  }

  private async revoke(url: string, account: StoredAccount): Promise<boolean> {
    const response = await this.request(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: account.refreshToken!,
        token_type_hint: "refresh_token",
        client_id: account.clientId,
      }).toString(),
    });
    return response.status === 200;
  }

  private async listenForCallback(attempt: PendingSignIn): Promise<{ callbackServer: Server; redirectUri: string }> {
    let complete!: (callback: OAuthCallback) => void;
    let fail!: (error: Error) => void;
    const result = new Promise<OAuthCallback>((resolve, reject) => { complete = resolve; fail = reject; });
    void result.catch(() => undefined);
    const server = createServer((request, response) => {
      const base = attempt.redirectUri ?? "http://127.0.0.1/";
      const url = new URL(request.url ?? "/", base);
      if (request.method !== "GET" || url.origin !== new URL(base).origin || url.pathname !== REDIRECT_PATH) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
        return;
      }
      const params = callbackParams(url);
      if (!params) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(safeHtml("This sign-in response could not be verified."));
        fail(new ChatGPTAuthError("The ChatGPT sign-in response contained duplicate fields.", "INVALID_CALLBACK"));
        return;
      }
      const returnedState = params.get("state");
      if (!returnedState || !urlSafeStateEquals(returnedState, attempt.state)) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(safeHtml("This sign-in response could not be verified."));
        fail(new ChatGPTAuthError("The ChatGPT sign-in response could not be verified.", "STATE_MISMATCH"));
        return;
      }
      const oauthError = params.get("error") ?? undefined;
      const code = params.get("code") ?? undefined;
      const clientId = params.get("client_id") ?? undefined;
      if (!oauthError && !code) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(safeHtml("The sign-in response was incomplete."));
        fail(new ChatGPTAuthError("The ChatGPT sign-in response was incomplete.", "INVALID_CALLBACK"));
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" })
        .end(safeHtml(oauthError ? "Sign-in was not completed." : "Sign-in is complete."));
      complete({ code, error: oauthError, clientId });
    });
    attempt.callbackServer = server;
    server.once("listening", () => {
      // A cancellation can win the race just before the OS finishes binding.
      // Close the socket when that late listen event arrives.
      if (attempt.cancelled) void this.closeCallbackServer(server);
    });
    server.once("error", (error) => fail(error));
    const listening = new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    server.listen(0, "127.0.0.1");
    await Promise.race([listening, attempt.cancelPromise]);
    const address = server.address() as AddressInfo;
    const redirectUri = `http://127.0.0.1:${address.port}${REDIRECT_PATH}`;
    attempt.redirectUri = redirectUri;
    attempt.callbackPromise = result;
    return { callbackServer: server, redirectUri };
  }

  private callbackResult(server: Server, attempt: PendingSignIn): Promise<OAuthCallback> {
    void server;
    return attempt.callbackPromise ?? Promise.reject(new ChatGPTAuthError("The callback listener was not ready.", "CALLBACK_LISTENER_FAILED"));
  }

  private async closeCallbackServer(server?: Server): Promise<void> {
    if (!server || !server.listening) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private withTransition<T>(operation: () => Promise<T>): Promise<T> {
    // Lifecycle hooks stay outside the mutation queue: stopping a worker can
    // wait for that worker's queued token refresh to finish.
    const run = this.transitionTail.then(async () => {
      await this.options.beforeChange?.();
      try {
        return await operation();
      } finally {
        await this.options.afterChange?.();
      }
    });
    this.transitionTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private withMutation<T>(operation: (state: StoredAuth) => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(async () => operation(await this.loadState()));
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async loadState(): Promise<StoredAuth> {
    if (this.state) return this.state;
    if (!this.statePromise) {
      this.statePromise = (async () => {
        let raw: string | null;
        try {
          raw = await this.options.credentials.get(CREDENTIAL_KEY);
        } catch (error) {
          if (!(error instanceof CredentialDecryptionError)) throw error;
          this.recoveryRequired = true;
          return freshStoredAuth();
        }
        if (raw === null) return freshStoredAuth();
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch {
          this.recoveryRequired = true;
          return freshStoredAuth();
        }
        const state = normalizedStoredAuth(parsed);
        if (!state) {
          this.recoveryRequired = true;
          return freshStoredAuth();
        }
        return state;
      })();
    }
    try {
      this.state = await this.statePromise;
      return this.state;
    } catch (error) {
      this.statePromise = null;
      throw error;
    }
  }

  private async persistIfMissing(state: StoredAuth): Promise<void> {
    // When the old blob cannot be decrypted or parsed, keep it untouched until
    // a fresh account identity has been validated and can replace it atomically.
    if (this.recoveryRequired) {
      this.state = state;
      return;
    }
    const raw = await this.options.credentials.get(CREDENTIAL_KEY);
    if (raw === null) await this.options.credentials.set(CREDENTIAL_KEY, JSON.stringify(state));
    this.state = state;
  }

  private async persist(state: StoredAuth, validatedRecovery = false): Promise<void> {
    if (this.recoveryRequired && !validatedRecovery) {
      throw new ChatGPTAuthError("Sign in to ChatGPT again to restore saved accounts.", "CREDENTIAL_STATE_INVALID");
    }
    await this.options.credentials.set(CREDENTIAL_KEY, JSON.stringify(state));
    this.state = state;
    this.statePromise = Promise.resolve(state);
    this.recoveryRequired = false;
  }
}
