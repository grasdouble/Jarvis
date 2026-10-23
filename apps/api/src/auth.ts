import {
  createHmac,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";

const OWNER_ID = "owner";
const PASSWORD_MIN_CODE_POINTS = 14;
const PASSWORD_MAX_BYTES = 1024;
const ONBOARDING_SECRET_MIN_BYTES = 32;
const TOKEN_BYTES = 32;
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_BYTES = 64;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const DEFAULT_INACTIVITY_MS = 30 * 60 * 1000;
const MAX_INACTIVITY_MS = 90 * 24 * 60 * 60 * 1000;

export interface OwnerCredential {
  readonly ownerId: string;
  readonly passwordHash: string;
}

export interface OwnerSessionToCreate {
  readonly ownerId: string;
  readonly tokenDigest: string;
  readonly csrfTokenDigest: string;
  readonly inactivityMs: number;
}

export interface ActiveOwnerSession {
  readonly ownerId: string;
  readonly csrfTokenDigest: string;
}

export interface OwnerAuthStore {
  findOwner(): Promise<OwnerCredential | null>;
  createOwner(owner: OwnerCredential): Promise<boolean>;
  createSession(session: OwnerSessionToCreate): Promise<void>;
  touchSession(tokenDigest: string, inactivityMs: number): Promise<ActiveOwnerSession | null>;
  revokeSession(tokenDigest: string): Promise<void>;
}

export interface OwnerSessionCredentials {
  readonly ownerId: string;
  readonly sessionToken: string;
  readonly csrfToken: string;
}

export interface AuthenticatedOwnerSession {
  readonly ownerId: string;
  readonly csrfTokenDigest: string;
}

export interface OwnerAuthService {
  readonly inactivityMs: number;
  onboard(secret: string, password: string): Promise<OwnerSessionCredentials | null>;
  login(password: string): Promise<OwnerSessionCredentials | null>;
  authenticate(sessionToken: string): Promise<AuthenticatedOwnerSession | null>;
  getSessionCsrf(sessionToken: string): Promise<{ ownerId: string; csrfToken: string } | null>;
  verifyCsrf(session: AuthenticatedOwnerSession, csrfToken: string): boolean;
  logout(sessionToken: string): Promise<void>;
  isOnboardingAvailable(): Promise<boolean>;
}

export interface CreateOwnerAuthServiceOptions {
  readonly store: OwnerAuthStore;
  /** Inject through trusted startup configuration. There is deliberately no default credential. */
  readonly onboardingSecret?: string;
  readonly inactivityMs?: number;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function digestHex(value: string): string {
  return sha256(value).toString("hex");
}

function constantTimeDigestEqual(left: string, right: string): boolean {
  return timingSafeEqual(sha256(left), sha256(right));
}

function randomToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

function csrfForSession(sessionToken: string): string {
  return createHmac("sha256", Buffer.from(sessionToken, "base64url"))
    .update("jarvis-owner-session-csrf-v1", "utf8")
    .digest("base64url");
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function validatePassword(password: string): void {
  if (Array.from(password).length < PASSWORD_MIN_CODE_POINTS || Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) {
    throw new TypeError("Password does not meet the local password policy.");
  }
}

function validateLoginPassword(password: unknown): password is string {
  return typeof password === "string" && Buffer.byteLength(password, "utf8") <= PASSWORD_MAX_BYTES;
}

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, SCRYPT_KEY_BYTES, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAX_MEMORY,
    }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await derivePassword(password, salt);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  const saltPart = parts[4] ?? "";
  const keyPart = parts[5] ?? "";
  if (parts.length !== 6 || parts[0] !== "scrypt" || parts[1] !== String(SCRYPT_N)
    || parts[2] !== String(SCRYPT_R) || parts[3] !== String(SCRYPT_P)
    || !/^[A-Za-z0-9_-]{22}$/.test(saltPart) || !/^[A-Za-z0-9_-]{86}$/.test(keyPart)) {
    await derivePassword(password, randomBytes(16));
    return false;
  }
  const salt = Buffer.from(saltPart, "base64url");
  const expected = Buffer.from(keyPart, "base64url");
  if (salt.length !== 16 || expected.length !== SCRYPT_KEY_BYTES
    || salt.toString("base64url") !== saltPart || expected.toString("base64url") !== keyPart) {
    await derivePassword(password, randomBytes(16));
    return false;
  }
  const actual = await derivePassword(password, salt);
  return timingSafeEqual(actual, expected);
}

function validateInactivity(inactivityMs: number): void {
  if (!Number.isSafeInteger(inactivityMs) || inactivityMs < 60_000 || inactivityMs > MAX_INACTIVITY_MS) {
    throw new TypeError("Session inactivity must be between one minute and 90 days.");
  }
}

/** Builds the single-account password, session, and CSRF service over a durable store. */
export function createOwnerAuthService(options: CreateOwnerAuthServiceOptions): OwnerAuthService {
  const { store } = options;
  const onboardingSecret = options.onboardingSecret;
  const inactivityMs = options.inactivityMs ?? DEFAULT_INACTIVITY_MS;
  validateInactivity(inactivityMs);
  if (onboardingSecret !== undefined
    && (Buffer.byteLength(onboardingSecret, "utf8") < ONBOARDING_SECRET_MIN_BYTES
      || Buffer.byteLength(onboardingSecret, "utf8") > 4096)) {
    throw new TypeError("Configured onboarding secret must contain 32–4096 UTF-8 bytes.");
  }
  const onboardingSecretDigest = onboardingSecret === undefined ? null : digestHex(onboardingSecret);

  async function createSession(ownerId: string): Promise<OwnerSessionCredentials> {
    const sessionToken = randomToken();
    const csrfToken = csrfForSession(sessionToken);
    await store.createSession({
      ownerId,
      tokenDigest: digestHex(sessionToken),
      csrfTokenDigest: digestHex(csrfToken),
      inactivityMs,
    });
    return { ownerId, sessionToken, csrfToken };
  }

  async function authenticateSession(sessionToken: string): Promise<AuthenticatedOwnerSession | null> {
    if (!validToken(sessionToken)) return null;
    const session = await store.touchSession(digestHex(sessionToken), inactivityMs);
    if (session === null || session.ownerId !== OWNER_ID || !/^[a-f0-9]{64}$/.test(session.csrfTokenDigest)) return null;
    return { ownerId: OWNER_ID, csrfTokenDigest: session.csrfTokenDigest };
  }

  function verifySessionCsrf(session: AuthenticatedOwnerSession, csrfToken: string): boolean {
    return validToken(csrfToken)
      && /^[a-f0-9]{64}$/.test(session.csrfTokenDigest)
      && timingSafeEqual(sha256(csrfToken), Buffer.from(session.csrfTokenDigest, "hex"));
  }

  return {
    inactivityMs,

    async onboard(secret, password): Promise<OwnerSessionCredentials | null> {
      if (onboardingSecretDigest === null || typeof secret !== "string"
        || Buffer.byteLength(secret, "utf8") > 4096
        || !timingSafeEqual(sha256(secret), Buffer.from(onboardingSecretDigest, "hex"))) return null;
      validatePassword(password);
      const passwordHash = await hashPassword(password);
      if (!await store.createOwner({ ownerId: OWNER_ID, passwordHash })) return null;
      return createSession(OWNER_ID);
    },

    async login(password): Promise<OwnerSessionCredentials | null> {
      if (!validateLoginPassword(password)) return null;
      const owner = await store.findOwner();
      if (owner === null) {
        await derivePassword(password, randomBytes(16));
        return null;
      }
      if (owner.ownerId !== OWNER_ID || !await verifyPassword(password, owner.passwordHash)) return null;
      return createSession(OWNER_ID);
    },

    authenticate: authenticateSession,

    async getSessionCsrf(sessionToken): Promise<{ ownerId: string; csrfToken: string } | null> {
      const session = await authenticateSession(sessionToken);
      if (session === null) return null;
      const csrfToken = csrfForSession(sessionToken);
      if (!verifySessionCsrf(session, csrfToken)) return null;
      return { ownerId: session.ownerId, csrfToken };
    },

    verifyCsrf: verifySessionCsrf,

    async logout(sessionToken): Promise<void> {
      if (validToken(sessionToken)) await store.revokeSession(digestHex(sessionToken));
    },

    async isOnboardingAvailable(): Promise<boolean> {
      return onboardingSecretDigest !== null && await store.findOwner() === null;
    },
  };
}

export interface OwnerAuthHttpRequest {
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  /** Must come from the accepted socket, never X-Forwarded-For unless a trusted proxy is configured. */
  readonly remoteAddress?: string;
}

export interface OwnerAuthHttpResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string | readonly string[]>>;
}

export interface OwnerAuthBoundaryOptions {
  /** Exact public origin served by the API and browser UI. */
  readonly origin: string;
}

export interface OwnerMutationAuthorization {
  readonly authorized: true;
  readonly auth: { readonly ownerId: string };
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
}

export interface OwnerMutationDenial {
  readonly authorized: false;
  readonly response: OwnerAuthHttpResponse;
}

export interface OwnerReadAuthorization {
  readonly authorized: true;
  readonly auth: { readonly ownerId: string };
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
}

export interface OwnerReadDenial {
  readonly authorized: false;
  readonly response: OwnerAuthHttpResponse;
}

export interface OwnerAuthBoundary {
  getSession(request: OwnerAuthHttpRequest): Promise<OwnerAuthHttpResponse>;
  onboard(request: OwnerAuthHttpRequest): Promise<OwnerAuthHttpResponse>;
  login(request: OwnerAuthHttpRequest): Promise<OwnerAuthHttpResponse>;
  logout(request: OwnerAuthHttpRequest): Promise<OwnerAuthHttpResponse>;
  authorizeRead(request: OwnerAuthHttpRequest): Promise<OwnerReadAuthorization | OwnerReadDenial>;
  authorizeMutation(request: OwnerAuthHttpRequest): Promise<OwnerMutationAuthorization | OwnerMutationDenial>;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

class LoginFailureLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private readonly windowMs = 15 * 60 * 1000;
  private readonly limit = 5;
  private readonly maximumInFlight = 4;
  private inFlight = 0;

  isLimited(key: string, now: number): boolean {
    const bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) {
      this.buckets.delete(key);
      return false;
    }
    return bucket.count >= this.limit;
  }

  begin(key: string, now: number): boolean {
    if (this.isLimited(key, now) || this.inFlight >= this.maximumInFlight) return false;
    this.inFlight += 1;
    return true;
  }

  finish(key: string, outcome: "success" | "failure" | "error", now: number): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (outcome === "success") this.buckets.delete(key);
    if (outcome === "failure") this.failure(key, now);
  }

  private failure(key: string, now: number): void {
    let bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + this.windowMs };
    bucket.count += 1;
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    if (this.buckets.size > 2048) this.buckets.delete(this.buckets.keys().next().value as string);
  }

}

function header(request: OwnerAuthHttpRequest, name: string): string | undefined {
  const key = Object.keys(request.headers).find((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? undefined : request.headers[key];
}

function readCookie(request: OwnerAuthHttpRequest, name: string): string | null {
  const raw = header(request, "cookie");
  if (raw === undefined || raw.length > 8192) return null;
  let value: string | null = null;
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    if (value !== null) return null;
    value = part.slice(separator + 1).trim();
  }
  return value;
}

function parseOrigin(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if (parsed.origin !== value || parsed.username !== "" || parsed.password !== "") return null;
    return parsed;
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function bodyObject(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const prototype = Object.getPrototypeOf(body);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return body as Record<string, unknown>;
}

function closedBody(body: unknown, allowed: readonly string[]): Record<string, unknown> | null {
  const object = bodyObject(body);
  if (object === null || Object.keys(object).some((key) => !allowed.includes(key))) return null;
  return object;
}

function sameOrigin(request: OwnerAuthHttpRequest, expectedOrigin: string, required: boolean): boolean {
  const supplied = header(request, "origin");
  return supplied === undefined ? !required : supplied === expectedOrigin && parseOrigin(supplied) !== null;
}

function sameCsrf(cookieToken: string | null, headerToken: string | undefined): boolean {
  return validToken(cookieToken) && validToken(headerToken)
    && constantTimeDigestEqual(cookieToken, headerToken);
}

function response(status: number, body?: unknown, cookies?: readonly string[]): OwnerAuthHttpResponse {
  return {
    status,
    ...(body === undefined ? {} : { body }),
    headers: {
      "cache-control": "no-store",
      ...(cookies === undefined ? {} : { "set-cookie": cookies }),
    },
  };
}

function appendCookie(attributes: readonly string[], secure: boolean): string {
  return [...attributes, "Path=/", "SameSite=Strict", ...(secure ? ["Secure"] : [])].join("; ");
}

/** Framework-neutral HTTP adapter. All browser mutations pass Origin and CSRF checks here. */
export function createOwnerAuthBoundary(service: OwnerAuthService, options: OwnerAuthBoundaryOptions): OwnerAuthBoundary {
  const parsedOrigin = parseOrigin(options.origin);
  if (parsedOrigin === null || (parsedOrigin.protocol !== "https:" && parsedOrigin.protocol !== "http:")) {
    throw new TypeError("Owner authentication requires one exact HTTP(S) origin.");
  }
  const secure = parsedOrigin.protocol === "https:";
  if (!secure && !isLoopbackHost(parsedOrigin.hostname)) {
    throw new TypeError("Unencrypted HTTP authentication is permitted only on a loopback origin.");
  }
  const sessionCookieName = secure ? "__Host-jarvis_session" : "jarvis_session";
  const csrfCookieName = secure ? "__Host-jarvis_csrf" : "jarvis_csrf";
  const maxAgeSeconds = Math.floor(service.inactivityMs / 1000);
  const limiter = new LoginFailureLimiter();

  const sessionCookie = (token: string): string => appendCookie([
    `${sessionCookieName}=${token}`, "HttpOnly", `Max-Age=${maxAgeSeconds}`,
  ], secure);
  const csrfCookie = (token: string): string => appendCookie([
    `${csrfCookieName}=${token}`, `Max-Age=${maxAgeSeconds}`,
  ], secure);
  const clearSessionCookie = (): string => appendCookie([
    `${sessionCookieName}=`, "HttpOnly", "Max-Age=0",
  ], secure);
  const clearCsrfCookie = (): string => appendCookie([
    `${csrfCookieName}=`, "Max-Age=0",
  ], secure);
  const sessionTokenFrom = (request: OwnerAuthHttpRequest): string | null => readCookie(request, sessionCookieName);
  const csrfCookieFrom = (request: OwnerAuthHttpRequest): string | null => readCookie(request, csrfCookieName);
  const csrfHeaderFrom = (request: OwnerAuthHttpRequest): string | undefined => header(request, "x-csrf-token");

  function preAuthenticationGuard(request: OwnerAuthHttpRequest): OwnerAuthHttpResponse | null {
    if (!sameOrigin(request, options.origin, true)) return response(403, { error: "origin_rejected" });
    if (!sameCsrf(csrfCookieFrom(request), csrfHeaderFrom(request))) return response(403, { error: "csrf_rejected" });
    return null;
  }

  async function credentialsResponse(credentials: OwnerSessionCredentials, status: number): Promise<OwnerAuthHttpResponse> {
    return response(status, { ownerId: credentials.ownerId, csrfToken: credentials.csrfToken }, [
      sessionCookie(credentials.sessionToken),
      csrfCookie(credentials.csrfToken),
    ]);
  }

  return {
    async getSession(request): Promise<OwnerAuthHttpResponse> {
      if (!sameOrigin(request, options.origin, false)) return response(403, { error: "origin_rejected" });
      const token = sessionTokenFrom(request);
      if (token !== null) {
        const refreshed = await service.getSessionCsrf(token);
        if (refreshed !== null) {
          return response(200, { authenticated: true, ownerId: refreshed.ownerId, csrfToken: refreshed.csrfToken }, [
            sessionCookie(token), csrfCookie(refreshed.csrfToken),
          ]);
        }
      }
      const previousCsrfToken = csrfCookieFrom(request);
      const csrfToken = validToken(previousCsrfToken) ? previousCsrfToken : randomToken();
      const cookies = [csrfCookie(csrfToken)];
      if (token !== null) cookies.unshift(clearSessionCookie());
      return response(200, {
        authenticated: false,
        onboardingAvailable: await service.isOnboardingAvailable(),
        csrfToken,
      }, cookies);
    },

    async onboard(request): Promise<OwnerAuthHttpResponse> {
      const denied = preAuthenticationGuard(request);
      if (denied !== null) return denied;
      const body = closedBody(request.body, ["secret", "password"]);
      if (body === null || typeof body.secret !== "string" || typeof body.password !== "string") {
        return response(422, { error: "invalid_request" });
      }
      try {
        const credentials = await service.onboard(body.secret, body.password);
        if (credentials === null) return response(403, { error: "onboarding_unavailable" });
        return credentialsResponse(credentials, 201);
      } catch (error) {
        if (error instanceof TypeError) return response(422, { error: "invalid_password" });
        throw error;
      }
    },

    async login(request): Promise<OwnerAuthHttpResponse> {
      const denied = preAuthenticationGuard(request);
      if (denied !== null) return denied;
      const body = closedBody(request.body, ["password"]);
      if (body === null || typeof body.password !== "string") return response(422, { error: "invalid_request" });
      const limiterKey = request.remoteAddress ?? "unknown";
      const now = Date.now();
      if (!limiter.begin(limiterKey, now)) return response(429, { error: "login_rate_limited" });
      let credentials: OwnerSessionCredentials | null;
      try {
        credentials = await service.login(body.password);
      } catch (error) {
        limiter.finish(limiterKey, "error", now);
        throw error;
      }
      if (credentials === null) {
        limiter.finish(limiterKey, "failure", now);
        return response(401, { error: "invalid_credentials" });
      }
      limiter.finish(limiterKey, "success", now);
      return credentialsResponse(credentials, 200);
    },

    async logout(request): Promise<OwnerAuthHttpResponse> {
      if (!sameOrigin(request, options.origin, true)) return response(403, { error: "origin_rejected" });
      const token = sessionTokenFrom(request);
      if (token === null || !validToken(token)) return response(401, { error: "unauthenticated" });
      if (!sameCsrf(csrfCookieFrom(request), csrfHeaderFrom(request))) return response(403, { error: "csrf_rejected" });
      const session = await service.authenticate(token);
      if (session !== null && !service.verifyCsrf(session, csrfHeaderFrom(request) ?? "")) {
        return response(403, { error: "csrf_rejected" });
      }
      await service.logout(token);
      return response(204, undefined, [clearSessionCookie(), clearCsrfCookie()]);
    },

    async authorizeRead(request): Promise<OwnerReadAuthorization | OwnerReadDenial> {
      if (!sameOrigin(request, options.origin, false)) {
        return { authorized: false, response: response(403, { error: "origin_rejected" }) };
      }
      const token = sessionTokenFrom(request);
      if (token === null || !validToken(token)) {
        return { authorized: false, response: response(401, { error: "unauthenticated" }) };
      }
      const refreshed = await service.getSessionCsrf(token);
      if (refreshed === null || refreshed.ownerId !== OWNER_ID) {
        return { authorized: false, response: response(401, { error: "unauthenticated" }) };
      }
      return {
        authorized: true,
        auth: { ownerId: refreshed.ownerId },
        headers: {
          "cache-control": "no-store",
          "set-cookie": [sessionCookie(token), csrfCookie(refreshed.csrfToken)],
        },
      };
    },

    async authorizeMutation(request): Promise<OwnerMutationAuthorization | OwnerMutationDenial> {
      if (!sameOrigin(request, options.origin, true)) {
        return { authorized: false, response: response(403, { error: "origin_rejected" }) };
      }
      const token = sessionTokenFrom(request);
      if (token === null || !validToken(token)) {
        return { authorized: false, response: response(401, { error: "unauthenticated" }) };
      }
      const csrfToken = csrfHeaderFrom(request);
      if (!validToken(csrfToken) || !sameCsrf(csrfCookieFrom(request), csrfToken)) {
        return { authorized: false, response: response(403, { error: "csrf_rejected" }) };
      }
      const session = await service.authenticate(token);
      if (session === null) return { authorized: false, response: response(401, { error: "unauthenticated" }) };
      if (!service.verifyCsrf(session, csrfToken)) {
        return { authorized: false, response: response(403, { error: "csrf_rejected" }) };
      }
      return {
        authorized: true,
        auth: { ownerId: session.ownerId },
        headers: {
          "cache-control": "no-store",
          "set-cookie": [sessionCookie(token), csrfCookie(csrfToken)],
        },
      };
    },
  };
}
