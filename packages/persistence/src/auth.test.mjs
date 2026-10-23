import assert from "node:assert/strict";
import { test } from "node:test";
import * as persistence from "../dist/index.js";

function poolFor(results = []) {
  const calls = [];
  const client = {
    async query(text, values = []) {
      calls.push({ text, values });
      return results.shift() ?? { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return { calls, async connect() { return client; } };
}

test("PostgresOwnerAuthStore is exported and maps the single owner credential", async () => {
  assert.equal(typeof persistence.PostgresOwnerAuthStore, "function");
  const pool = poolFor([{ rows: [{ ownerId: "owner", passwordHash: "scrypt$fixture" }], rowCount: 1 }]);
  const store = new persistence.PostgresOwnerAuthStore(pool);
  assert.deepEqual(await store.findOwner(), { ownerId: "owner", passwordHash: "scrypt$fixture" });
  assert.match(pool.calls[0].text, /FROM jarvis\.owner_accounts/);
  assert.match(pool.calls[0].text, /singleton = true/);
});

test("owner initialization is a single-row insert that never stores the onboarding secret", async () => {
  const pool = poolFor([{ rows: [], rowCount: 1 }, { rows: [], rowCount: 0 }]);
  const store = new persistence.PostgresOwnerAuthStore(pool);
  const credential = { ownerId: "owner", passwordHash: "scrypt$encoded-password-hash" };
  assert.equal(await store.createOwner(credential), true);
  assert.equal(await store.createOwner(credential), false);
  assert.match(pool.calls[0].text, /ON CONFLICT \(singleton\) DO NOTHING/);
  assert.deepEqual(pool.calls[0].values, [credential.ownerId, credential.passwordHash]);
  assert.doesNotMatch(pool.calls[0].text, /onboarding_secret|raw_password/i);
  await assert.rejects(store.createOwner({ ownerId: "attacker", passwordHash: "x" }), /single local owner/);
});

test("server-side session store extends only active sessions and supports revocation", async () => {
  const pool = poolFor([
    { rows: [], rowCount: 1 },
    { rows: [{ ownerId: "owner", csrfTokenDigest: "b".repeat(64) }], rowCount: 1 },
    { rows: [], rowCount: 1 },
  ]);
  const store = new persistence.PostgresOwnerAuthStore(pool);
  const session = { ownerId: "owner", tokenDigest: "a".repeat(64), csrfTokenDigest: "b".repeat(64), inactivityMs: 60_000 };
  await store.createSession(session);
  assert.deepEqual(await store.touchSession(session.tokenDigest, 60_000), {
    ownerId: "owner", csrfTokenDigest: "b".repeat(64),
  });
  await store.revokeSession(session.tokenDigest);
  assert.match(pool.calls[1].text, /expires_at > now\(\)/);
  assert.match(pool.calls[2].text, /revoked_at = now\(\)/);
  assert.deepEqual(pool.calls[0].values, ["owner", "a".repeat(64), "b".repeat(64), 60_000]);
  await assert.rejects(store.touchSession("tampered", 60_000), /SHA-256 digest/);
});
