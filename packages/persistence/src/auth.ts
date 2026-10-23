import type { SqlPool } from "./index.js";

export interface OwnerCredential {
  ownerId: string;
  passwordHash: string;
}

export interface NewOwnerSession {
  ownerId: string;
  tokenDigest: string;
  csrfTokenDigest: string;
  inactivityMs: number;
}

export interface ActiveOwnerSession {
  ownerId: string;
  csrfTokenDigest: string;
}

function assertDigest(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${field} must be a SHA-256 digest.`);
}

function assertInactivity(inactivityMs: number): void {
  if (!Number.isSafeInteger(inactivityMs) || inactivityMs < 60_000 || inactivityMs > 90 * 24 * 60 * 60 * 1000) {
    throw new TypeError("Session inactivity must be between one minute and 90 days.");
  }
}

/** PostgreSQL store for the single local owner and opaque, server-side sessions. */
export class PostgresOwnerAuthStore {
  constructor(private readonly pool: SqlPool) {}

  async findOwner(): Promise<OwnerCredential | null> {
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<OwnerCredential>(`
        SELECT owner_id AS "ownerId", password_hash AS "passwordHash"
        FROM jarvis.owner_accounts
        WHERE singleton = true
      `);
      return rows[0] ?? null;
    } finally {
      client.release();
    }
  }

  async createOwner(owner: OwnerCredential): Promise<boolean> {
    if (owner.ownerId !== "owner") throw new TypeError("Only the single local owner account is supported.");
    if (typeof owner.passwordHash !== "string" || owner.passwordHash.length < 1 || owner.passwordHash.length > 256) {
      throw new TypeError("Password hash is invalid.");
    }
    const client = await this.pool.connect();
    try {
      const { rowCount } = await client.query(`
        INSERT INTO jarvis.owner_accounts (singleton, owner_id, password_hash)
        VALUES (true, $1, $2)
        ON CONFLICT (singleton) DO NOTHING
      `, [owner.ownerId, owner.passwordHash]);
      return rowCount === 1;
    } finally {
      client.release();
    }
  }

  async createSession(session: NewOwnerSession): Promise<void> {
    if (session.ownerId !== "owner") throw new TypeError("Only the single local owner account is supported.");
    assertDigest(session.tokenDigest, "tokenDigest");
    assertDigest(session.csrfTokenDigest, "csrfTokenDigest");
    assertInactivity(session.inactivityMs);
    const client = await this.pool.connect();
    try {
      await client.query(`
        INSERT INTO jarvis.owner_sessions (owner_id, token_digest, csrf_token_digest, expires_at)
        VALUES ($1, $2, $3, now() + ($4::double precision * interval '1 millisecond'))
      `, [session.ownerId, session.tokenDigest, session.csrfTokenDigest, session.inactivityMs]);
    } finally {
      client.release();
    }
  }

  async touchSession(tokenDigest: string, inactivityMs: number): Promise<ActiveOwnerSession | null> {
    assertDigest(tokenDigest, "tokenDigest");
    assertInactivity(inactivityMs);
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<ActiveOwnerSession>(`
        UPDATE jarvis.owner_sessions
        SET last_seen_at = now(), expires_at = now() + ($2::double precision * interval '1 millisecond')
        WHERE token_digest = $1
          AND revoked_at IS NULL
          AND expires_at > now()
        RETURNING owner_id AS "ownerId", csrf_token_digest AS "csrfTokenDigest"
      `, [tokenDigest, inactivityMs]);
      return rows[0] ?? null;
    } finally {
      client.release();
    }
  }

  async revokeSession(tokenDigest: string): Promise<void> {
    assertDigest(tokenDigest, "tokenDigest");
    const client = await this.pool.connect();
    try {
      await client.query(`
        UPDATE jarvis.owner_sessions
        SET revoked_at = now()
        WHERE token_digest = $1 AND revoked_at IS NULL
      `, [tokenDigest]);
    } finally {
      client.release();
    }
  }
}
