import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import * as api from "../dist/index.js";

const origin = "http://127.0.0.1:3000";
const onboardingSecret = "test-only-onboarding-secret-with-adequate-entropy-123456";
const password = "a long, owner-selected passphrase for the local account";

class MemoryOwnerAuthStore {
  owner = null;
  sessions = new Map();
  now = 1_800_000_000_000;

  async findOwner() {
    return this.owner;
  }

  async createOwner(owner) {
    if (this.owner) return false;
    this.owner = { ...owner };
    return true;
  }

  async createSession(session) {
    this.sessions.set(session.tokenDigest, {
      ownerId: session.ownerId,
      csrfTokenDigest: session.csrfTokenDigest,
      expiresAt: this.now + session.inactivityMs,
      revoked: false,
    });
  }

  async touchSession(tokenDigest, inactivityMs) {
    const session = this.sessions.get(tokenDigest);
    if (!session || session.revoked || session.expiresAt <= this.now) return null;
    session.expiresAt = this.now + inactivityMs;
    return { ownerId: session.ownerId, csrfTokenDigest: session.csrfTokenDigest };
  }

  async revokeSession(tokenDigest) {
    const session = this.sessions.get(tokenDigest);
    if (session) session.revoked = true;
  }
}

function getCookie(response, name) {
  const setCookies = response.headers["set-cookie"] ?? [];
  const cookie = setCookies.find((entry) => entry.startsWith(`${name}=`));
  assert.ok(cookie, `expected a ${name} cookie`);
  return cookie.split(";", 1)[0];
}

function headersFor(response, csrfToken, requestOrigin = origin) {
  return {
    origin: requestOrigin,
    cookie: (response.headers["set-cookie"] ?? []).map((cookie) => cookie.split(";", 1)[0]).join("; "),
    "x-csrf-token": csrfToken,
    "content-type": "application/json",
  };
}

async function newAuth(options = {}) {
  const store = new MemoryOwnerAuthStore();
  const service = api.createOwnerAuthService({
    store,
    onboardingSecret,
    inactivityMs: 30 * 60 * 1000,
    ...options,
  });
  const boundary = api.createOwnerAuthBoundary(service, { origin });
  return { store, service, boundary };
}

test("owner authentication boundary and service are available", () => {
  assert.equal(typeof api.createOwnerAuthService, "function");
  assert.equal(typeof api.createOwnerAuthBoundary, "function");
  assert.equal(typeof api.createAuthenticatedRequestIntakeBoundary, "function");
});

test("one-time onboarding stores only a password hash and login never returns credentials", async () => {
  const { store, boundary } = await newAuth();
  const challenge = await boundary.getSession({ headers: {} });
  const csrfToken = challenge.body.csrfToken;
  assert.equal(challenge.headers["cache-control"], "no-store");
  const request = {
    headers: headersFor(challenge, csrfToken),
    body: { secret: onboardingSecret, password },
    remoteAddress: "127.0.0.1",
  };

  const onboarded = await boundary.onboard(request);
  assert.equal(onboarded.status, 201);
  assert.equal(store.owner.ownerId, "owner");
  assert.notEqual(store.owner.passwordHash, password);
  assert.match(store.owner.passwordHash, /^scrypt\$/);
  assert.equal(JSON.stringify(onboarded.body).includes(onboardingSecret), false);
  assert.equal(JSON.stringify(onboarded.body).includes(password), false);
  assert.equal("sessionToken" in onboarded.body, false);

  const repeated = await boundary.onboard({ ...request, headers: headersFor(onboarded, onboarded.body.csrfToken) });
  assert.notEqual(repeated.status, 201);

  const loggedInHeaders = headersFor(onboarded, onboarded.body.csrfToken);
  const login = await boundary.login({
    headers: loggedInHeaders,
    body: { password },
    remoteAddress: "127.0.0.1",
  });
  assert.equal(login.status, 200);
  assert.equal(login.headers["cache-control"], "no-store");
  assert.equal(login.body.ownerId, "owner");
  assert.equal("sessionToken" in login.body, false);
  assert.equal(JSON.stringify(login.body).includes(password), false);
  const sessionCookie = getCookie(login, "jarvis_session");
  assert.match(sessionCookie, /^jarvis_session=[A-Za-z0-9_-]{43}$/);
  const tokenDigest = createHash("sha256").update(sessionCookie.slice("jarvis_session=".length)).digest("hex");
  assert.ok(store.sessions.has(tokenDigest));
  assert.equal(store.sessions.has(sessionCookie.slice("jarvis_session=".length)), false);
  assert.match(login.headers["set-cookie"].find((entry) => entry.startsWith("jarvis_session=")), /HttpOnly/);
  assert.match(login.headers["set-cookie"].find((entry) => entry.startsWith("jarvis_session=")), /SameSite=Strict/);
  assert.doesNotMatch(login.headers["set-cookie"].find((entry) => entry.startsWith("jarvis_session=")), /; Secure(?:;|$)/);

  const failed = await boundary.login({
    headers: loggedInHeaders,
    body: { password: "incorrect owner passphrase" },
    remoteAddress: "127.0.0.1",
  });
  assert.equal(failed.status, 401);
  assert.doesNotMatch(JSON.stringify(failed.body), /incorrect|password|secret/i);

  for (let attempt = 1; attempt < 5; attempt += 1) {
    assert.equal((await boundary.login({
      headers: loggedInHeaders,
      body: { password: "another incorrect owner passphrase" },
      remoteAddress: "127.0.0.1",
    })).status, 401);
  }
  assert.equal((await boundary.login({
    headers: loggedInHeaders,
    body: { password: "another incorrect owner passphrase" },
    remoteAddress: "127.0.0.1",
  })).status, 429);
});

test("expired, revoked, and tampered opaque sessions never authenticate", async () => {
  const { store, service, boundary } = await newAuth();
  const challenge = await boundary.getSession({ headers: {} });
  const csrfToken = challenge.body.csrfToken;
  const onboarding = await boundary.onboard({
    headers: headersFor(challenge, csrfToken),
    body: { secret: onboardingSecret, password },
  });
  const sessionCookie = getCookie(onboarding, "jarvis_session");
  const sessionToken = sessionCookie.slice("jarvis_session=".length);
  const csrfCookie = getCookie(onboarding, "jarvis_csrf");
  const authenticated = await service.authenticate(sessionToken);
  assert.equal(authenticated.ownerId, "owner");

  const tampered = `${sessionToken.slice(0, -1)}${sessionToken.endsWith("a") ? "b" : "a"}`;
  assert.equal(await service.authenticate(tampered), null);

  const logout = await boundary.logout({
    headers: {
      origin,
      cookie: `${sessionCookie}; ${csrfCookie}`,
      "x-csrf-token": onboarding.body.csrfToken,
    },
  });
  assert.equal(logout.status, 204);
  assert.equal(await service.authenticate(sessionToken), null);

  const nextChallenge = await boundary.getSession({ headers: {} });
  const secondLogin = await boundary.login({
    headers: headersFor(nextChallenge, nextChallenge.body.csrfToken),
    body: { password },
  });
  assert.equal(secondLogin.status, 200);
  const expiringToken = getCookie(secondLogin, "jarvis_session").slice("jarvis_session=".length);
  store.now += 30 * 60 * 1000 + 1;
  assert.equal(await service.authenticate(expiringToken), null);
});

test("Origin and CSRF failures are rejected before request intake effects", async () => {
  const { boundary } = await newAuth();
  const challenge = await boundary.getSession({ headers: {} });
  const csrfToken = challenge.body.csrfToken;
  await boundary.onboard({
    headers: headersFor(challenge, csrfToken),
    body: { secret: onboardingSecret, password },
  });
  const login = await boundary.login({
    headers: headersFor(challenge, csrfToken),
    body: { password },
  });
  const cookie = (login.headers["set-cookie"] ?? []).map((entry) => entry.split(";", 1)[0]).join("; ");
  const submitted = [];
  const intake = {
    async submit(ownerId, request) {
      submitted.push({ ownerId, request });
      return { id: "request-1", state: "clarification", version: 1 };
    },
    async clarify(ownerId) {
      submitted.push({ ownerId });
      return { id: "request-1", state: "queued", version: 2 };
    },
  };
  const protectedIntake = api.createAuthenticatedRequestIntakeBoundary(intake, boundary);
  const unauthenticated = await protectedIntake.submit({
    headers: { origin }, body: { prompt: "blocked" }, idempotencyKey: "unauthenticated",
  });
  const base = {
    headers: { origin, cookie, "x-csrf-token": login.body.csrfToken },
    body: { prompt: "plan this", ownerId: "attacker" },
    idempotencyKey: "request-key",
  };

  const wrongOrigin = await protectedIntake.submit({ ...base, headers: { ...base.headers, origin: "https://attacker.example" } });
  const missingCsrf = await protectedIntake.submit({ ...base, headers: { origin, cookie } });
  const wrongCsrf = await protectedIntake.submit({ ...base, headers: { ...base.headers, "x-csrf-token": "tampered" } });
  assert.equal(wrongOrigin.status, 403);
  assert.equal(missingCsrf.status, 403);
  assert.equal(wrongCsrf.status, 403);
  assert.equal(unauthenticated.status, 401);
  assert.equal(submitted.length, 0);

  const bodySpoof = await protectedIntake.submit(base);
  assert.equal(bodySpoof.status, 422);
  assert.equal(submitted.length, 0);

  const accepted = await protectedIntake.submit({
    ...base,
    body: { prompt: "plan this" },
  });
  assert.equal(accepted.status, 202);
  assert.equal(submitted[0].ownerId, "owner");
  assert.equal("ownerId" in submitted[0].request, false);
  const renewedCookies = accepted.headers["set-cookie"];
  const renewedSessionCookie = renewedCookies.find((entry) => entry.startsWith("jarvis_session="));
  const renewedCsrfCookie = renewedCookies.find((entry) => entry.startsWith("jarvis_csrf="));
  assert.ok(renewedSessionCookie, "authenticated mutation renews the session cookie");
  assert.ok(renewedCsrfCookie, "authenticated mutation renews the CSRF cookie");
  assert.match(renewedSessionCookie, /Max-Age=1800/);
  assert.match(renewedCsrfCookie, /Max-Age=1800/);
  assert.equal(renewedCsrfCookie.split(";", 1)[0], getCookie(login, "jarvis_csrf"));
});

test("onboarding is disabled without an injected one-time secret and onboarding secrets are not persisted", async () => {
  const { store, boundary } = await newAuth({ onboardingSecret: undefined });
  const challenge = await boundary.getSession({ headers: {} });
  assert.equal(challenge.body.onboardingAvailable, false);
  const response = await boundary.onboard({
    headers: headersFor(challenge, challenge.body.csrfToken),
    body: { secret: onboardingSecret, password },
  });
  assert.notEqual(response.status, 201);
  assert.equal(store.owner, null);
});

test("login bounds simultaneous password-hash work", async () => {
  let active = 0;
  let peak = 0;
  const pending = [];
  const service = {
    inactivityMs: 30 * 60 * 1000,
    async onboard() { return null; },
    login() {
      active += 1;
      peak = Math.max(peak, active);
      return new Promise((resolve) => pending.push(() => {
        active -= 1;
        resolve(null);
      }));
    },
    async authenticate() { return null; },
    async getSessionCsrf() { return null; },
    verifyCsrf() { return false; },
    async logout() {},
    async isOnboardingAvailable() { return false; },
  };
  const boundary = api.createOwnerAuthBoundary(service, { origin });
  const challenge = await boundary.getSession({ headers: {} });
  const request = {
    headers: headersFor(challenge, challenge.body.csrfToken),
    body: { password },
    remoteAddress: "127.0.0.1",
  };
  const attempts = Array.from({ length: 5 }, () => boundary.login(request));
  assert.equal(peak, 4);
  pending.forEach((resolve) => resolve());
  const responses = await Promise.all(attempts);
  assert.deepEqual(responses.map(({ status }) => status), [401, 401, 401, 401, 429]);
});

test("HTTPS cookies use Secure host-only session and readable CSRF cookies", async () => {
  const service = api.createOwnerAuthService({
    store: new MemoryOwnerAuthStore(),
    onboardingSecret,
  });
  const httpsOrigin = "https://jarvis.example";
  const boundary = api.createOwnerAuthBoundary(service, { origin: httpsOrigin });
  const challenge = await boundary.getSession({ headers: {} });
  const csrfCookie = challenge.headers["set-cookie"].find((entry) => entry.startsWith("__Host-jarvis_csrf="));
  assert.match(csrfCookie, /; Secure(?:;|$)/);
  assert.doesNotMatch(csrfCookie, /HttpOnly/);
  assert.match(csrfCookie, /SameSite=Strict/);
  const onboarded = await boundary.onboard({
    headers: {
      origin: httpsOrigin,
      cookie: csrfCookie.split(";", 1)[0],
      "x-csrf-token": challenge.body.csrfToken,
    },
    body: { secret: onboardingSecret, password },
  });
  assert.equal(onboarded.status, 201);
  const sessionCookie = onboarded.headers["set-cookie"].find((entry) => entry.startsWith("__Host-jarvis_session="));
  assert.match(sessionCookie, /; Secure(?:;|$)/);
  assert.match(sessionCookie, /; HttpOnly(?:;|$)/);
  assert.match(sessionCookie, /; Path=\/(?:;|$)/);
  assert.match(sessionCookie, /; SameSite=Strict(?:;|$)/);
  assert.doesNotMatch(sessionCookie, /Domain=/);
  assert.throws(() => api.createOwnerAuthBoundary(service, { origin: "http://0.0.0.0:3000" }), /loopback origin/);
});
