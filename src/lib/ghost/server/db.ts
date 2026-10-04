import path from "node:path";
import fs from "node:fs";
import { S } from "./state";

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Db extends Queryable {
  kind: "pglite" | "postgres";
  /** Run fn inside one transaction (BEGIN/COMMIT, ROLLBACK on throw). */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface DbOptions {
  /** Postgres URL (Neon etc). Defaults to process.env.DATABASE_URL. */
  databaseUrl?: string;
  /** PGlite data dir; "memory" for an in-memory database (tests). Default .ghost/pgdata */
  dataDir?: string;
  /** Postgres schema to use (created if missing). Default GHOST_DB_SCHEMA or "public". */
  schema?: string;
}

const MIGRATIONS: string[] = [
  `create table if not exists principals (
    principal_id text primary key,
    display_name text not null,
    owner_token text not null unique,
    kind text not null default 'human',
    created_at timestamptz not null default now()
  )`,
  `create table if not exists connectors (
    connector_id text primary key,
    owner_id text not null,
    label text not null,
    connector_kind text not null,
    credential_hash text unique,
    created_at timestamptz not null default now(),
    last_seen timestamptz
  )`,
  `create table if not exists pairings (
    pairing_id text primary key,
    owner_id text not null,
    code text not null,
    status text not null,
    label text,
    connector_kind text,
    nonce text,
    connector_id text,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null
  )`,
  `create index if not exists pairings_code_idx on pairings (code)`,
  `create table if not exists devices (
    device_id text primary key,
    owner_id text not null,
    connector_id text not null,
    local_key text not null,
    manifest jsonb not null,
    terms_override jsonb,
    status text not null,
    online boolean not null default true,
    last_heartbeat timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (connector_id, local_key)
  )`,
  `create table if not exists offers (
    offer_id text primary key,
    visitor_id text not null,
    owner_id text not null,
    refs jsonb not null,
    price_cents integer not null,
    currency text not null default 'USD',
    duration_s integer not null,
    quota integer,
    terms_version text not null,
    expires_at timestamptz not null,
    round integer not null default 0,
    status text not null,
    host_message text,
    list_price_cents integer not null,
    floor_cents integer not null,
    requires_approval boolean not null default false,
    lease_id text,
    created_at timestamptz not null default now()
  )`,
  `create table if not exists leases (
    lease_id text primary key,
    offer_id text,
    visitor_id text not null,
    owner_id text not null,
    refs jsonb not null,
    state text not null,
    revision integer not null default 1,
    starts_at timestamptz,
    ends_at timestamptz,
    duration_s integer not null,
    quota integer,
    used integer not null default 0,
    price_cents integer not null,
    payment jsonb,
    reason text,
    requires_approval boolean not null default false,
    implicit boolean not null default false,
    reserve_expires_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create index if not exists leases_visitor_idx on leases (visitor_id, state)`,
  `create index if not exists leases_owner_idx on leases (owner_id, state)`,
  /* Exclusivity: one held lock per (device, concurrency group) across all live leases. */
  `create table if not exists lease_locks (
    lease_id text not null,
    device_id text not null,
    concurrency_group text not null,
    held boolean not null default true,
    primary key (lease_id, device_id, concurrency_group)
  )`,
  `create unique index if not exists lease_locks_exclusive on lease_locks (device_id, concurrency_group) where held`,
  `create table if not exists invocations (
    invocation_id text primary key,
    lease_id text,
    visitor_id text not null,
    device_id text not null,
    capability_id text not null,
    arguments jsonb not null,
    state text not null,
    error text,
    observation_id text,
    output jsonb,
    idempotency_key text,
    lease_revision integer,
    upload_token_hash text,
    upload_expires_at timestamptz,
    upload_used boolean not null default false,
    deadline timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create unique index if not exists invocations_idem on invocations (visitor_id, idempotency_key) where idempotency_key is not null`,
  `create table if not exists observations (
    observation_id text primary key,
    invocation_id text,
    device_id text not null,
    capability_id text not null,
    kind text not null,
    captured_at timestamptz,
    retrieved_at timestamptz not null default now(),
    media bytea,
    media_type text,
    body jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  )`,
  `create table if not exists experiences (
    experience_id text primary key,
    visitor_id text not null,
    goal text not null,
    refs jsonb not null,
    zone_id text,
    outcome text not null,
    cost_cents integer not null default 0,
    latency_ms integer,
    failures jsonb not null default '[]'::jsonb,
    evidence jsonb not null default '[]'::jsonb,
    summary text not null,
    created_at timestamptz not null default now()
  )`,
  `create table if not exists ledger_entries (
    entry_id text primary key,
    principal_id text not null,
    amount_cents integer not null,
    currency text not null default 'USD',
    kind text not null,
    lease_id text,
    label text not null,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists ledger_principal_idx on ledger_entries (principal_id, created_at)`,
];

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function migrate(db: Db) {
  for (const sql of MIGRATIONS) await db.query(sql);
}

async function openPostgres(url: string, schema?: string): Promise<Db> {
  const pg = await import("pg");
  const Pool = pg.default?.Pool ?? (pg as unknown as { Pool: typeof import("pg").Pool }).Pool;
  const needsSsl = /sslmode=require|neon\.tech/i.test(url);
  if (schema && !/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`invalid schema name ${schema}`);
  // A non-default schema uses search_path via the `options` startup parameter, which poolers
  // (e.g. Neon's "-pooler" PgBouncer endpoint) reject: use the direct endpoint in that case.
  const altSchema = !!schema && schema !== "public";
  const pool = new Pool({
    connectionString: altSchema ? url.replace(/-pooler(\.)/, "$1") : url,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    max: 8,
    // Keep connections warm: reconnecting to a remote Postgres (TLS handshake) costs ~1s.
    idleTimeoutMillis: 300_000,
    keepAlive: true,
    connectionTimeoutMillis: 15_000,
    ...(altSchema ? { options: `-c search_path=${schema}` } : {}),
  });
  pool.on("error", (e) => console.error("[ghost] pg pool error", e.message));
  if (altSchema) await pool.query(`create schema if not exists ${schema}`);
  const db: Db = {
    kind: "postgres",
    async query(sql, params) {
      const r = await pool.query(sql, params as unknown[]);
      return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const q: Queryable = {
          async query(sql, params) {
            const r = await client.query(sql, params as unknown[]);
            return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
          },
        };
        const out = await fn(q);
        await client.query("commit");
        return out;
      } catch (e) {
        await client.query("rollback").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
  return db;
}

async function openPglite(dataDir: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  let pgl;
  if (dataDir === "memory") {
    pgl = await PGlite.create();
  } else {
    const dir = path.resolve(dataDir);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    pgl = await PGlite.create(dir);
  }
  const wrap = (r: { rows: unknown[]; affectedRows?: number }) => ({
    rows: r.rows,
    rowCount: r.affectedRows ?? r.rows.length,
  });
  const db: Db = {
    kind: "pglite",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async query(sql, params): Promise<any> {
      return wrap(await pgl.query(sql, params as unknown[]));
    },
    async tx(fn) {
      return pgl.transaction(async (tx) => {
        const q: Queryable = {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          async query(sql, params): Promise<any> {
            return wrap(await tx.query(sql, params as unknown[]));
          },
        };
        return fn(q);
      });
    },
    async close() {
      await pgl.close();
    },
  };
  return db;
}

/** Open (once) and migrate the coordinator database. */
export function openDb(opts: DbOptions = {}): Promise<Db> {
  const st = S();
  if (st.db) return Promise.resolve(st.db);
  if (st.dbPromise) return st.dbPromise;
  const url = opts.databaseUrl ?? process.env.DATABASE_URL;
  const dataDir = opts.dataDir ?? process.env.GHOST_PGDATA ?? path.join(process.cwd(), ".ghost", "pgdata");
  const forceLocal = process.env.GHOST_DB === "pglite";
  st.dbPromise = (async () => {
    let db: Db;
    if (url && !forceLocal) {
      let pgDb: Db | null = null;
      try {
        pgDb = await withTimeout(openPostgres(url, opts.schema ?? process.env.GHOST_DB_SCHEMA), 20_000, "Postgres connect timed out");
        await withTimeout(pgDb.query("select 1"), 15_000, "Postgres did not answer within 15s");
        db = pgDb;
      } catch (e) {
        void pgDb?.close().catch(() => {});
        if (process.env.GHOST_DB_FALLBACK === "0") throw e;
        // Keep the open-source core usable offline / on flaky networks: fall back loudly to PGlite.
        console.error(
          `[ghost] WARNING: cannot reach DATABASE_URL (${(e as Error).message}). Falling back to embedded PGlite at ${dataDir}. ` +
            `Data written now will NOT be in Postgres. Set GHOST_DB_FALLBACK=0 to fail instead.`,
        );
        db = await openPglite(dataDir);
      }
    } else {
      db = await openPglite(dataDir);
    }
    await migrate(db);
    st.db = db;
    return db;
  })();
  st.dbPromise.catch(() => {
    st.dbPromise = null;
  });
  return st.dbPromise;
}

/** The open database. Throws if startCoordinator()/openDb() has not completed. */
export function db(): Db {
  const d = S().db;
  if (!d) throw new Error("GHOST database not open yet (call startCoordinator first)");
  return d;
}

export async function dbReady(): Promise<Db> {
  const st = S();
  if (st.db) return st.db;
  if (st.dbPromise) return st.dbPromise;
  return openDb();
}
