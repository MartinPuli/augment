/** Cross-instance device routing for Vercel. Postgres is the authority; sockets stay local. */
import { randomUUID } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { db } from "./db";

export function distributed(): boolean { return process.env.GHOST_DISTRIBUTED === "1" || process.env.VERCEL === "1"; }
export function background(work: Promise<unknown>): void {
  const safe = work.catch((error) => console.error("[ghost] background operation failed", error instanceof Error ? error.message : "unknown error"));
  if (process.env.VERCEL === "1") waitUntil(safe);
}

type Handler = (message: unknown) => void | Promise<void>;
type Binding = { token: string; handler: Handler; lost?: () => void };
export class ClusterBus {
  readonly instance = randomUUID();
  private bindings = new Map<string, Binding>();
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private refreshed = 0;
  private cleaned = 0;

  /** A new connector supersedes the old connection. Viewer IDs use exclusive registration. */
  async bind(key: string, handler: Handler, options: { exclusive?: boolean; lost?: () => void } = {}): Promise<string | null> {
    const token = randomUUID();
    const r = await db().query(
      `insert into ghost_routes (route_key, instance_id, session_token, expires_at)
       values ($1,$2,$3,now()+interval '20 seconds')
       on conflict (route_key) do update set instance_id=$2, session_token=$3, expires_at=excluded.expires_at
       ${options.exclusive ? "where ghost_routes.expires_at < now()" : ""} returning route_key`,
      [key, this.instance, token],
    );
    if (!r.rowCount) return null;
    const previous = this.bindings.get(key);
    this.bindings.set(key, { token, handler, lost: options.lost });
    previous?.lost?.();
    this.start();
    return token;
  }
  async unbind(key: string, token: string): Promise<boolean> {
    if (this.bindings.get(key)?.token === token) this.bindings.delete(key);
    const r = await db().query(`delete from ghost_routes where route_key=$1 and session_token=$2 returning route_key`, [key, token]);
    return r.rowCount > 0;
  }
  async present(key: string): Promise<boolean> {
    return (await db().query(`select 1 from ghost_routes where route_key=$1 and expires_at>now()`, [key])).rowCount > 0;
  }
  async send(key: string, payload: unknown): Promise<boolean> {
    const r = await db().query(
      `insert into ghost_messages (route_key, instance_id, session_token, payload, expires_at)
       select route_key, instance_id, session_token, $2::jsonb, now()+interval '20 seconds'
       from ghost_routes where route_key=$1 and expires_at>now() returning message_id`, [key, JSON.stringify(payload)],
    );
    return r.rowCount > 0;
  }
  async broadcast(payload: unknown): Promise<void> {
    await db().query(`insert into ghost_messages (route_key, instance_id, session_token, payload, expires_at)
      select route_key, instance_id, session_token, $1::jsonb, now()+interval '20 seconds'
      from ghost_routes where route_key like 'events:%' and instance_id<>$2 and expires_at>now()`, [JSON.stringify(payload), this.instance]);
  }
  private start() {
    if (this.timer) return;
    this.timer = setInterval(() => background(this.poll()), 250);
    this.timer.unref();
  }
  async poll(): Promise<void> {
    if (this.polling || !this.bindings.size) return;
    this.polling = true;
    try {
      if (Date.now() - this.refreshed > 5000) {
        const current = [...this.bindings.entries()];
        const r = await db().query<{ route_key: string; session_token: string }>(
          `update ghost_routes set expires_at=now()+interval '20 seconds' where instance_id=$1
           and session_token=any($2::text[]) returning route_key,session_token`, [this.instance, current.map(([, b]) => b.token)],
        );
        const alive = new Set(r.rows.map(row => row.session_token));
        for (const [key, b] of current) if (!alive.has(b.token) && this.bindings.get(key) === b) {
          this.bindings.delete(key); b.lost?.();
        }
        this.refreshed = Date.now();
      }
      // Claim once. Losing the process after delivery means "unknown", never replay an action.
      const r = await db().query<{ message_id: string; route_key: string; session_token: string; payload: unknown }>(
        `delete from ghost_messages where message_id in (
           select m.message_id from ghost_messages m join ghost_routes r on r.route_key=m.route_key and r.session_token=m.session_token
           where m.instance_id=$1 and m.expires_at>now() and r.expires_at>now()
           order by m.message_id limit 100 for update of m skip locked
         ) returning message_id,route_key,session_token,payload`, [this.instance],
      );
      r.rows.sort((a,b) => Number(BigInt(a.message_id)-BigInt(b.message_id)));
      for (const message of r.rows) {
        const b = this.bindings.get(message.route_key);
        if (b?.token === message.session_token) await b.handler(message.payload);
      }
      if (Date.now() - this.cleaned > 60_000) {
        await db().query(`delete from ghost_messages where expires_at<now()`);
        await db().query(`delete from ghost_routes where expires_at<now()-interval '1 minute'`);
        await db().query(`delete from ghost_rate_limits where resets_at<now()-interval '1 hour'`);
        this.cleaned = Date.now();
      }
    } finally { this.polling = false; }
  }
  async stop() {
    clearInterval(this.timer); this.timer = undefined;
    this.bindings.clear();
    await db().query(`delete from ghost_routes where instance_id=$1`, [this.instance]);
    await db().query(`delete from ghost_messages where instance_id=$1`, [this.instance]);
  }
}

declare global { var __ghostCluster: ClusterBus | undefined; }
export function cluster(): ClusterBus { return globalThis.__ghostCluster ??= new ClusterBus(); }

export async function sharedRateLimit(key: string, max: number, windowMs: number): Promise<boolean> {
  const r = await db().query<{ used: number }>(
    `insert into ghost_rate_limits (bucket,used,resets_at) values ($1,1,now()+$3*interval '1 millisecond')
     on conflict (bucket) do update set
       used=case when ghost_rate_limits.resets_at<=now() then 1 else ghost_rate_limits.used+1 end,
       resets_at=case when ghost_rate_limits.resets_at<=now() then excluded.resets_at else ghost_rate_limits.resets_at end
     where ghost_rate_limits.resets_at<=now() or ghost_rate_limits.used<$2 returning used`, [key,max,windowMs],
  );
  return r.rowCount > 0;
}
