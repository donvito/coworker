import { beforeAll, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { CredentialDecryptionError, MemoryCredentialStore } from "@main/security/credential-store";
import { ChatGPTAuthService } from "@main/security/chatgpt-auth";

const ISSUER = "https://auth.openai.com";
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
const FULL_SCOPES = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`;
const credentialKey = "model:openai:chatgpt";

let signingKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let publicJwk: JWK;
let alternateSigningKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

beforeAll(async () => {
  const primary = await generateKeyPair("RS256", { modulusLength: 2048 });
  signingKey = primary.privateKey;
  publicJwk = { ...(await exportJWK(primary.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  alternateSigningKey = (await generateKeyPair("RS256", { modulusLength: 2048 })).privateKey;
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface HarnessOptions {
  credentials?: MemoryCredentialStore;
  now?: () => number;
  beforeChange?: () => Promise<void>;
  afterChange?: () => Promise<void>;
  openExternal?: (url: string) => Promise<void>;
  callbackTimeoutMs?: number;
  callback?: (authorize: URL, callback: URL) => void;
  token?: (form: URLSearchParams, authorize: URL | undefined, now: number) => Promise<Response>;
  revoke?: (form: URLSearchParams) => Promise<Response>;
}

function createHarness(options: HarnessOptions = {}) {
  const credentials = options.credentials ?? new MemoryCredentialStore();
  const authorizeRequests: URL[] = [];
  const tokenRequests: URLSearchParams[] = [];
  const revocationRequests: URLSearchParams[] = [];
  let lastAuthorize: URL | undefined;
  let exchangeCount = 0;
  let refreshCount = 0;
  let jwksCount = 0;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return jsonResponse({
        issuer: ISSUER,
        jwks_uri: `${ISSUER}/.well-known/jwks.json`,
        revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke`,
      });
    }
    if (url === `${ISSUER}/.well-known/jwks.json`) {
      jwksCount++;
      return jsonResponse({ keys: [publicJwk] });
    }
    if (url === TOKEN_URL) {
      const form = new URLSearchParams(String(init?.body ?? ""));
      tokenRequests.push(form);
      if (form.get("grant_type") === "authorization_code") exchangeCount++;
      if (form.get("grant_type") === "refresh_token") refreshCount++;
      return options.token
        ? options.token(form, lastAuthorize, options.now?.() ?? Date.now())
        : defaultToken(form, lastAuthorize, options.now?.() ?? Date.now());
    }
    if (url === `${ISSUER}/api/accounts/oauth/revoke`) {
      const form = new URLSearchParams(String(init?.body ?? ""));
      revocationRequests.push(form);
      return options.revoke ? options.revoke(form) : new Response(null, { status: 200 });
    }
    throw new Error(`Unexpected URL in test: ${url}`);
  });

  async function openExternal(rawUrl: string): Promise<void> {
    const authorize = new URL(rawUrl);
    lastAuthorize = authorize;
    authorizeRequests.push(authorize);
    const callback = new URL(authorize.searchParams.get("redirect_uri")!);
    callback.searchParams.set("code", `auth-code-${authorizeRequests.length}`);
    callback.searchParams.set("state", authorize.searchParams.get("state")!);
    if (authorize.searchParams.get("client_id") === "dynamic_agent_client") {
      callback.searchParams.set("client_id", `oaiapp-${authorizeRequests.length}`);
    }
    options.callback?.(authorize, callback);
    const response = await fetch(callback);
    await response.arrayBuffer();
  }

  const service = new ChatGPTAuthService({
    credentials,
    openExternal: options.openExternal ?? openExternal,
    fetchImpl,
    now: options.now,
    callbackTimeoutMs: options.callbackTimeoutMs,
    beforeChange: options.beforeChange,
    afterChange: options.afterChange,
  });
  return {
    service,
    credentials,
    authorizeRequests,
    tokenRequests,
    revocationRequests,
    fetchImpl,
    get exchangeCount() { return exchangeCount; },
    get refreshCount() { return refreshCount; },
    get jwksCount() { return jwksCount; },
    async responseFor(form: URLSearchParams, authorize = lastAuthorize, now = options.now?.() ?? Date.now(), extra: Record<string, unknown> = {}) {
      return defaultToken(form, authorize, now, extra);
    },
  };
}

async function defaultToken(
  form: URLSearchParams,
  authorize: URL | undefined,
  now: number,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  if (form.get("grant_type") === "refresh_token") {
    const refreshIndex = 2;
    return jsonResponse({
      access_token: `access-refreshed-${refreshIndex}`,
      refresh_token: "refresh-2",
      token_type: "Bearer",
      expires_in: 3600,
      scope: FULL_SCOPES,
      ...extra,
    });
  }
  const clientId = form.get("client_id")!;
  const nonce = authorize?.searchParams.get("nonce") ?? "expected-nonce";
  const claims = isObject(extra.claims) ? extra.claims : {};
  const key = extra.signingKey ?? signingKey;
  let signer = new SignJWT({
    nonce,
    email: "person@example.com",
    name: "Alex",
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: typeof extra.kid === "string" ? extra.kid : "test-key" })
    .setIssuer(typeof extra.issuer === "string" ? extra.issuer : ISSUER)
    .setAudience(typeof extra.audience === "string" ? extra.audience : clientId);
  if (extra.missingSubject !== true) signer = signer.setSubject(typeof extra.subject === "string" ? extra.subject : "subject-1");
  if (extra.missingIssuedAt !== true) signer = signer.setIssuedAt(Math.floor(now / 1000));
  if (extra.missingExpiration !== true) {
    signer = signer.setExpirationTime(Math.floor(now / 1000) + (extra.expired === true ? -1 : 3600));
  }
  const idToken = await signer.sign(key as CryptoKey);
  const scopes = typeof extra.scope === "string" ? extra.scope : FULL_SCOPES;
  const body: Record<string, unknown> = {
    access_token: `access-${Date.now()}-${Math.random()}`,
    refresh_token: `refresh-${Date.now()}-${Math.random()}`,
    id_token: idToken,
    token_type: "Bearer",
    expires_in: 3600,
    scope: scopes,
    ...extra,
  };
  delete body.claims;
  delete body.signingKey;
  delete body.issuer;
  delete body.audience;
  delete body.subject;
  delete body.missingSubject;
  delete body.missingExpiration;
  delete body.expired;
  delete body.missingIssuedAt;
  delete body.kid;
  return jsonResponse(body);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("ChatGPTAuthService", () => {
  it("starts the official loopback PKCE flow and stores a signature- and nonce-validated registration", async () => {
    const harness = createHarness();
    const status = await harness.service.startSignIn();
    const authorize = harness.authorizeRequests[0]!;
    const callback = new URL(authorize.searchParams.get("redirect_uri")!);

    expect(callback.hostname).toBe("127.0.0.1");
    expect(callback.pathname).toBe("/auth/callback");
    expect(authorize.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(authorize.searchParams.get("agent_name_hint")).toBe("Coworker");
    expect(authorize.searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:/);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("resource")).toBe("https://api.openai.com/v1");
    expect(authorize.searchParams.get("scope")).toContain(DIRECT_SCOPE);
    expect(harness.tokenRequests[0]?.get("redirect_uri")).toBe(callback.toString());
    expect(harness.tokenRequests[0]?.get("client_id")).toBe("oaiapp-1");
    expect(status).toMatchObject({ mode: "api-key", state: "connected", accounts: [{ email: "person@example.com", connected: true, planUsageEnabled: true }] });
    const stored = await harness.credentials.get(credentialKey);
    expect(stored).toContain("urn:uuid:");
    expect(stored).toContain("refresh-");
  });

  it("rejects callback state mismatches and duplicate query fields before token exchange", async () => {
    const wrongState = createHarness({ callback: (_authorize, callback) => callback.searchParams.set("state", "wrong") });
    await expect(wrongState.service.startSignIn()).rejects.toMatchObject({ code: "STATE_MISMATCH" });
    expect(wrongState.exchangeCount).toBe(0);
    expect((await wrongState.service.status()).accounts).toEqual([]);

    const duplicate = createHarness({ callback: (_authorize, callback) => callback.searchParams.append("code", "second-code") });
    await expect(duplicate.service.startSignIn()).rejects.toMatchObject({ code: "INVALID_CALLBACK" });
    expect(duplicate.exchangeCount).toBe(0);
  });

  it("rejects invalid signature, issuer, audience, subject, and nonce without activating an account", async () => {
    const cases: Array<{ name: string; extra: Record<string, unknown> }> = [
      { name: "signature", extra: { signingKey: alternateSigningKey } },
      { name: "issuer", extra: { issuer: "https://attacker.example" } },
      { name: "audience", extra: { audience: "another-client" } },
      { name: "subject", extra: { missingSubject: true } },
      { name: "nonce", extra: { claims: { nonce: "wrong-nonce" } } },
      { name: "missing expiration", extra: { missingExpiration: true } },
      { name: "expired", extra: { expired: true } },
      { name: "missing issued-at", extra: { missingIssuedAt: true } },
    ];
    for (const testCase of cases) {
      const harness = createHarness({ token: async (form, authorize) => defaultToken(form, authorize, Date.now(), testCase.extra) });
      const error = await harness.service.startSignIn().then(() => null, (caught) => caught);
      if (!error) throw new Error(`Invalid identity case unexpectedly succeeded: ${testCase.name}`);
      expect(error).toMatchObject({ code: "INVALID_ID_TOKEN" });
      expect((await harness.service.status()).accounts).toEqual([]);
    }
  });

  it("retains a valid identity when the token response omits direct plan-use permission", async () => {
    const harness = createHarness({ token: async (form, authorize, now) => defaultToken(form, authorize, now, { scope: "openid profile email offline_access" }) });
    const status = await harness.service.startSignIn();
    expect(status.accounts[0]).toMatchObject({ connected: true, planUsageEnabled: false });
    await harness.service.setMode("chatgpt-subscription");
    await expect(harness.service.getAccessToken()).rejects.toMatchObject({ code: "PLAN_USAGE_NOT_AUTHORIZED" });
    expect(harness.refreshCount).toBe(0);
  });

  it("requires both granted ChatGPT usage and inference scopes", async () => {
    const harness = createHarness({ token: (form, authorize, now) => defaultToken(form, authorize, now, {
      scope: `openid profile email offline_access ${DIRECT_SCOPE}`,
    }) });
    const status = await harness.service.startSignIn();
    expect(status.accounts[0]).toMatchObject({ connected: true, planUsageEnabled: false });
    await harness.service.setMode("chatgpt-subscription");
    await expect(harness.service.getAccessToken()).rejects.toMatchObject({ code: "PLAN_USAGE_NOT_AUTHORIZED" });
    expect(harness.refreshCount).toBe(0);
  });

  it("recovers an unreadable encrypted auth blob only after a validated fresh sign-in", async () => {
    class UnreadableCredentialStore extends MemoryCredentialStore {
      unreadable = true;
      override async get(key: string): Promise<string | null> {
        if (key === credentialKey && this.unreadable) throw new CredentialDecryptionError();
        return super.get(key);
      }
      override async set(key: string, value: string): Promise<void> {
        await super.set(key, value);
        if (key === credentialKey) this.unreadable = false;
      }
    }
    const credentials = new UnreadableCredentialStore();
    const harness = createHarness({ credentials });

    await expect(harness.service.status()).resolves.toMatchObject({ state: "sign-in-required", accounts: [] });
    await expect(harness.service.acknowledgeWelcome()).rejects.toMatchObject({ code: "CREDENTIAL_STATE_INVALID" });
    await expect(credentials.get(credentialKey)).rejects.toBeInstanceOf(CredentialDecryptionError);
    await expect(harness.service.startSignIn()).resolves.toMatchObject({ state: "connected", accounts: [{ connected: true }] });
    const saved = JSON.parse((await credentials.get(credentialKey))!);
    expect(saved.accounts).toHaveLength(1);
    expect(saved.hostId).toMatch(/^urn:uuid:/);
  });

  it("recovers malformed stored JSON through an explicit validated sign-in", async () => {
    const credentials = new MemoryCredentialStore();
    await credentials.set(credentialKey, "{broken");
    const harness = createHarness({ credentials });

    await expect(harness.service.status()).resolves.toMatchObject({ state: "sign-in-required", accounts: [] });
    await expect(harness.service.startSignIn()).resolves.toMatchObject({ state: "connected", accounts: [{ connected: true }] });
    const saved = JSON.parse((await credentials.get(credentialKey))!);
    expect(saved.accounts).toHaveLength(1);
  });

  it("rejects a returning callback with a different registration without replacing the active account", async () => {
    const harness = createHarness({ callback: (authorize, callback) => {
      if (authorize.searchParams.get("client_id") !== "dynamic_agent_client") callback.searchParams.set("client_id", "oaiapp-other");
    } });
    const first = await harness.service.startSignIn();
    const activeId = first.activeAccountId;
    await expect(harness.service.startSignIn(activeId!)).rejects.toMatchObject({ code: "CLIENT_MISMATCH" });
    expect((await harness.service.status()).activeAccountId).toBe(activeId);
    expect(harness.exchangeCount).toBe(1);
  });

  it("rejects a returning registration whose signed subject differs from the saved account", async () => {
    let changedSubject = false;
    const harness = createHarness({ token: (form, authorize, now) => defaultToken(form, authorize, now, {
      ...(changedSubject ? { subject: "different-subject" } : {}),
    }) });
    const first = await harness.service.startSignIn();
    const activeId = first.activeAccountId;
    const savedBefore = JSON.parse((await harness.credentials.get(credentialKey))!);
    changedSubject = true;

    await expect(harness.service.startSignIn(activeId!)).rejects.toMatchObject({ code: "INVALID_ID_TOKEN" });
    expect((await harness.service.status()).activeAccountId).toBe(activeId);
    const savedAfter = JSON.parse((await harness.credentials.get(credentialKey))!);
    expect(savedAfter.accounts[0].refreshToken).toBe(savedBefore.accounts[0].refreshToken);
    expect(harness.exchangeCount).toBe(2);
  });

  it("cancels while the browser opener is pending and closes the loopback listener", async () => {
    const opened = deferred<string>();
    const releaseOpener = deferred<void>();
    const harness = createHarness({ openExternal: async (url) => {
      opened.resolve(url);
      await releaseOpener.promise;
    } });
    const signIn = harness.service.startSignIn();
    const authorize = new URL(await opened.promise);
    const callback = new URL(authorize.searchParams.get("redirect_uri")!);

    await harness.service.cancelSignIn();
    releaseOpener.resolve();
    await expect(signIn).rejects.toMatchObject({ code: "SIGN_IN_CANCELLED" });
    await expect(fetch(callback)).rejects.toThrow();
  });

  it("times out an unanswered browser callback and closes the listener", async () => {
    let authorizeUrl: string | undefined;
    const harness = createHarness({ callbackTimeoutMs: 15, openExternal: async (url) => { authorizeUrl = url; } });

    await expect(harness.service.startSignIn()).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    const callback = new URL(new URL(authorizeUrl!).searchParams.get("redirect_uri")!);
    await expect(fetch(callback)).rejects.toThrow();
    expect((await harness.service.status()).state).toBe("disconnected");
  });

  it("refreshes the trusted JWKS once for a rotated signing key and again after its cache TTL", async () => {
    let currentNow = Date.now();
    const originalKey = signingKey;
    const originalJwk = publicJwk;
    let tokenExtra: Record<string, unknown> = {};
    const harness = createHarness({ now: () => currentNow, token: (form, authorize, now) => defaultToken(form, authorize, now, tokenExtra) });
    try {
      await harness.service.startSignIn();
      expect(harness.jwksCount).toBe(1);
      const rotated = await generateKeyPair("RS256", { modulusLength: 2048 });
      signingKey = rotated.privateKey;
      publicJwk = { ...(await exportJWK(rotated.publicKey)), kid: "rotated-key", alg: "RS256", use: "sig" };
      tokenExtra = { kid: "rotated-key" };
      const second = await harness.service.startSignIn();
      expect(second.accounts).toHaveLength(2);
      expect(harness.jwksCount).toBe(2);

      currentNow += 16 * 60_000;
      await harness.service.startSignIn(second.activeAccountId!);
      expect(harness.jwksCount).toBe(3);
    } finally {
      signingKey = originalKey;
      publicJwk = originalJwk;
    }
  });

  it("retries an expired registration code with the issued client ID", async () => {
    let failExchange = true;
    const harness = createHarness({ token: async (form, authorize, now) => {
      if (form.get("grant_type") === "authorization_code" && failExchange) {
        failExchange = false;
        return jsonResponse({ error: "invalid_grant", error_description: "contains secret-value" }, 400);
      }
      return defaultToken(form, authorize, now);
    }, callback: (authorize, callback) => {
      if (authorize.searchParams.get("client_id") === "dynamic_agent_client") callback.searchParams.set("client_id", "oaiapp-issued");
      if (authorize.searchParams.get("client_id") === "oaiapp-issued") callback.searchParams.delete("client_id");
    } });

    await expect(harness.service.startSignIn()).rejects.toMatchObject({ code: "AUTHORIZATION_EXPIRED" });
    await expect(harness.service.startSignIn()).resolves.toMatchObject({ state: "connected" });
    expect(harness.authorizeRequests[1]?.searchParams.get("client_id")).toBe("oaiapp-issued");
    expect(harness.authorizeRequests[1]?.searchParams.has("agent_name_hint")).toBe(false);
    expect(harness.tokenRequests[1]?.get("client_id")).toBe("oaiapp-issued");
  });

  it("cancels an in-flight code exchange and discards its late credentials", async () => {
    const exchangeStarted = deferred<void>();
    const releaseExchange = deferred<Response>();
    const harness = createHarness({ token: async (form, authorize, now) => {
      if (form.get("grant_type") === "authorization_code") {
        exchangeStarted.resolve();
        await releaseExchange.promise;
        return defaultToken(form, authorize, now);
      }
      return defaultToken(form, authorize, now);
    } });
    const signIn = harness.service.startSignIn();
    await exchangeStarted.promise;
    expect((await harness.service.status()).state).toBe("waiting");
    await harness.service.cancelSignIn();
    releaseExchange.resolve(jsonResponse({}));
    await expect(signIn).rejects.toMatchObject({ code: "SIGN_IN_CANCELLED" });
    expect((await harness.service.status()).accounts).toEqual([]);
    expect(await harness.credentials.get(credentialKey)).toBeTruthy();
    const saved = JSON.parse((await harness.credentials.get(credentialKey))!);
    expect(saved.accounts).toEqual([]);
  });

  it("keeps the host and registration mapping across restart, separates equal emails, and switches only saved sessions", async () => {
    let currentNow = Date.now();
    let reg = 0;
    const credentials = new MemoryCredentialStore();
    const create = () => createHarness({ credentials, now: () => currentNow, callback: (authorize, callback) => {
        if (authorize.searchParams.get("client_id") === "dynamic_agent_client") callback.searchParams.set("client_id", `oaiapp-${++reg}`);
      } });
    const first = create();
    const firstStatus = await first.service.startSignIn();
    const storedFirst = JSON.parse((await credentials.get(credentialKey))!);
    const hostId = storedFirst.hostId;
    const firstId = firstStatus.accounts[0]!.id;
    const second = create();
    await second.service.startSignIn();
    const afterSecond = await second.service.status();
    expect(afterSecond.accounts).toHaveLength(2);
    expect(afterSecond.accounts[0]?.email).toBe(afterSecond.accounts[1]?.email);
    expect(afterSecond.accounts[0]?.label).not.toBe(afterSecond.accounts[1]?.label);
    await second.service.selectAccount(firstId);
    expect((await second.service.status()).activeAccountId).toBe(firstId);
    currentNow += 10;
    const restarted = create();
    expect((await restarted.service.status()).activeAccountId).toBe(firstId);
    expect(JSON.parse((await credentials.get(credentialKey))!).hostId).toBe(hostId);
  });

  it("serializes concurrent refreshes and respects earliest_refresh_at", async () => {
    let currentNow = Date.now();
    let refreshCalls = 0;
    let earliest = currentNow + 3590_000;
    const harness = createHarness({ now: () => currentNow, token: async (form, authorize, now) => {
      if (form.get("grant_type") === "refresh_token") refreshCalls++;
      const response = await defaultToken(form, authorize, now);
      if (form.get("grant_type") === "authorization_code") {
        const data = await response.json() as Record<string, unknown>;
        data.earliest_refresh_at = earliest;
        return jsonResponse(data);
      }
      return response;
    } });
    await harness.service.startSignIn();
    await harness.service.setMode("chatgpt-subscription");
    currentNow += 3550_000;
    const heldToken = await harness.service.getAccessToken();
    expect(heldToken).toMatch(/^access-/);
    expect(refreshCalls).toBe(0);
    currentNow = earliest;
    const tokens = await Promise.all(Array.from({ length: 5 }, () => harness.service.getAccessToken()));
    expect(new Set(tokens).size).toBe(1);
    expect(refreshCalls).toBe(1);
  });

  it("serializes disconnect after a concurrent refresh and revokes the rotated token", async () => {
    let currentNow = Date.now();
    const refreshStarted = deferred<void>();
    const releaseRefresh = deferred<void>();
    const beforeChange = vi.fn(async () => undefined);
    const afterChange = vi.fn(async () => undefined);
    const harness = createHarness({ now: () => currentNow, beforeChange, afterChange, token: async (form, authorize, now) => {
      if (form.get("grant_type") === "refresh_token") {
        refreshStarted.resolve();
        await releaseRefresh.promise;
      }
      return defaultToken(form, authorize, now);
    } });
    await harness.service.startSignIn();
    await harness.service.setMode("chatgpt-subscription");
    currentNow += 3550_000;
    const access = harness.service.getAccessToken();
    await refreshStarted.promise;
    const disconnect = harness.service.disconnect();
    releaseRefresh.resolve();
    await access;
    await expect(disconnect).resolves.toEqual({ revocationConfirmed: true });
    expect(harness.revocationRequests[0]?.get("token")).toBe("refresh-2");
    expect((await harness.service.status()).state).toBe("disconnected");
    expect((await harness.service.status()).accounts).toHaveLength(1);
    expect(beforeChange).toHaveBeenCalled();
    expect(afterChange).toHaveBeenCalled();
  });

  it("preserves saved credentials on transient errors, clears unusable refresh grants, and sanitizes response bodies", async () => {
    let currentNow = Date.now();
    let behavior: "transient" | "terminal" | "leak" = "transient";
    const harness = createHarness({ now: () => currentNow, token: async (form, authorize, now) => {
      if (form.get("grant_type") === "refresh_token") {
        if (behavior === "transient") return jsonResponse({ error: "server_error", error_description: "do-not-leak" }, 503);
        if (behavior === "terminal") return jsonResponse({ error: "invalid_grant", error_description: "secret-refresh-token" }, 400);
        return jsonResponse({ error: "invalid_client", error_description: "secret-access-token" }, 400);
      }
      return defaultToken(form, authorize, now);
    } });
    await harness.service.startSignIn();
    await harness.service.setMode("chatgpt-subscription");
    currentNow += 3550_000;
    await expect(harness.service.getAccessToken()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect((await harness.service.status()).state).toBe("connected");
    behavior = "leak";
    const leakError = await harness.service.getAccessToken().catch((error) => error as Error);
    expect(leakError instanceof Error ? leakError.message : String(leakError)).not.toContain("secret-access-token");
    expect((await harness.service.status()).state).toBe("connected");
    behavior = "terminal";
    await expect(harness.service.getAccessToken()).rejects.toMatchObject({ code: "SIGN_IN_REQUIRED" });
    expect((await harness.service.status()).state).toBe("sign-in-required");
    const saved = JSON.parse((await harness.credentials.get(credentialKey))!);
    expect(saved.accounts[0].refreshToken).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain("secret-refresh-token");
  });

  it("clears local credentials when revocation is unavailable and reports that revocation was not confirmed", async () => {
    const harness = createHarness({ revoke: async () => { throw new TypeError("network down"); } });
    await harness.service.startSignIn();
    await expect(harness.service.disconnect()).resolves.toEqual({ revocationConfirmed: false });
    expect((await harness.service.status()).state).toBe("disconnected");
    const saved = JSON.parse((await harness.credentials.get(credentialKey))!);
    expect(saved.accounts[0].clientId).toBe("oaiapp-1");
    expect(saved.accounts[0].refreshToken).toBeUndefined();
  });
});
