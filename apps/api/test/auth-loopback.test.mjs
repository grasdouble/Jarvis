import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { test } from "node:test";
import * as api from "../dist/index.js";

class MemoryOwnerAuthStore {
  owner = null;
  sessions = new Map();

  async findOwner() {
    return this.owner;
  }

  async createOwner(owner) {
    if (this.owner !== null) return false;
    this.owner = owner;
    return true;
  }

  async createSession(session) {
    this.sessions.set(session.tokenDigest, { ...session, revoked: false, expiresAt: Date.now() + session.inactivityMs });
  }

  async touchSession(tokenDigest, inactivityMs) {
    const session = this.sessions.get(tokenDigest);
    if (!session || session.revoked || session.expiresAt <= Date.now()) return null;
    session.expiresAt = Date.now() + inactivityMs;
    return { ownerId: session.ownerId, csrfTokenDigest: session.csrfTokenDigest };
  }

  async revokeSession(tokenDigest) {
    const session = this.sessions.get(tokenDigest);
    if (session) session.revoked = true;
  }
}

function cookiePairs(setCookies) {
  return setCookies.map((value) => value.split(";", 1)[0]).join("; ");
}

test("loopback HTTP adapter issues HttpOnly SameSite cookies and completes onboarding/logout", async () => {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const headers = {
      ...(request.headers.origin === undefined ? {} : { origin: String(request.headers.origin) }),
      ...(request.headers.cookie === undefined ? {} : { cookie: String(request.headers.cookie) }),
      ...(request.headers["x-csrf-token"] === undefined ? {} : { "x-csrf-token": String(request.headers["x-csrf-token"]) }),
    };
    const httpRequest = {
      headers,
      ...(bodyText.length === 0 ? {} : { body: JSON.parse(bodyText) }),
      ...(request.socket.remoteAddress === undefined ? {} : { remoteAddress: request.socket.remoteAddress }),
    };
    const result = request.method === "GET"
      ? await boundary.getSession(httpRequest)
      : request.url === "/api/v1/session/onboard"
        ? await boundary.onboard(httpRequest)
        : await boundary.logout(httpRequest);
    response.statusCode = result.status;
    for (const [name, value] of Object.entries(result.headers ?? {})) response.setHeader(name, value);
    if (result.body === undefined) {
      response.end();
    } else {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify(result.body));
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const store = new MemoryOwnerAuthStore();
  const service = api.createOwnerAuthService({
    store,
    onboardingSecret: "loopback-test-onboarding-secret-with-enough-randomness",
  });
  const boundary = api.createOwnerAuthBoundary(service, { origin });

  try {
    const initialResponse = await globalThis.fetch(`${origin}/api/v1/session`, { cache: "no-store" });
    const initial = await initialResponse.json();
    const csrfCookie = initialResponse.headers.get("set-cookie");
    assert.equal(initialResponse.status, 200);
    assert.equal(initial.authenticated, false);
    assert.ok(csrfCookie?.includes("SameSite=Strict"));
    assert.ok(csrfCookie?.includes("Path=/"));
    assert.doesNotMatch(csrfCookie ?? "", /; Secure(?:;|$)/);
    assert.doesNotMatch(csrfCookie ?? "", /HttpOnly/);

    const csrfCookiePair = cookiePairs([csrfCookie.split(", ")[0]]);
    const onboardResponse = await globalThis.fetch(`${origin}/api/v1/session/onboard`, {
      method: "POST",
      headers: {
        origin,
        cookie: csrfCookiePair,
        "x-csrf-token": initial.csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ secret: "loopback-test-onboarding-secret-with-enough-randomness", password: "a loopback owner password phrase" }),
    });
    const onboarded = await onboardResponse.json();
    const setCookies = onboardResponse.headers.get("set-cookie") ?? "";
    assert.equal(onboardResponse.status, 201);
    assert.match(setCookies, /HttpOnly/);
    assert.match(setCookies, /SameSite=Strict/);
    assert.doesNotMatch(setCookies, /; Secure(?:;|$)/);
    assert.equal(JSON.stringify(onboarded).includes("loopback-test-onboarding-secret"), false);

    const individualCookies = setCookies.split(", ");
    const sessionCookie = individualCookies.find((value) => value.startsWith("jarvis_session="));
    const nextCsrfCookie = individualCookies.find((value) => value.startsWith("jarvis_csrf="));
    assert.ok(sessionCookie);
    assert.ok(nextCsrfCookie);
    const authenticatedResponse = await globalThis.fetch(`${origin}/api/v1/session`, {
      headers: { cookie: `${sessionCookie.split(";", 1)[0]}; ${nextCsrfCookie.split(";", 1)[0]}` },
      cache: "no-store",
    });
    assert.equal(authenticatedResponse.status, 200);
    assert.equal((await authenticatedResponse.json()).authenticated, true);

    const logoutResponse = await globalThis.fetch(`${origin}/api/v1/session/logout`, {
      method: "POST",
      headers: {
        origin,
        cookie: `${sessionCookie.split(";", 1)[0]}; ${nextCsrfCookie.split(";", 1)[0]}`,
        "x-csrf-token": onboarded.csrfToken,
      },
    });
    assert.equal(logoutResponse.status, 204);
    assert.match(logoutResponse.headers.get("set-cookie") ?? "", /Max-Age=0/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
