import type { LedgerEntry, LedgerResponse } from "../client/api-types";
import { DEV_LEDGER_LABEL } from "../client/api-types";
import { db, type Queryable } from "./db";
import { emit } from "./events";
import { id, iso } from "./util";

export { DEV_LEDGER_LABEL };
export const INITIAL_TEST_FUNDS_CENTS = 500;

export async function balanceOf(q: Queryable, principal_id: string): Promise<number> {
  const r = await q.query<{ b: number | string | null }>(
    `select coalesce(sum(amount_cents), 0)::int as b from ledger_entries where principal_id = $1`,
    [principal_id],
  );
  return Number(r.rows[0]?.b ?? 0);
}

export async function addEntry(
  q: Queryable,
  e: { principal_id: string; amount_cents: number; kind: LedgerEntry["kind"]; lease_id?: string | null; label: string },
): Promise<string> {
  const entry_id = id("led");
  await q.query(
    `insert into ledger_entries (entry_id, principal_id, amount_cents, currency, kind, lease_id, label)
     values ($1, $2, $3, 'USD', $4, $5, $6)`,
    [entry_id, e.principal_id, Math.trunc(e.amount_cents), e.kind, e.lease_id ?? null, e.label],
  );
  return entry_id;
}

/** Emit ledger.updated for the given principals (call after the transaction commits). */
export async function emitLedger(...principal_ids: string[]): Promise<void> {
  for (const pid of new Set(principal_ids)) {
    if (!pid || pid.startsWith("provider:")) continue;
    emit({ type: "ledger.updated", principal_id: pid, balance_cents: await balanceOf(db(), pid) });
  }
}

type EntryRow = {
  entry_id: string;
  principal_id: string;
  amount_cents: number;
  currency: string;
  kind: LedgerEntry["kind"];
  lease_id: string | null;
  label: string;
  created_at: unknown;
};

export async function getLedger(principal_id: string, limit = 100): Promise<LedgerResponse> {
  const r = await db().query<EntryRow>(
    `select * from ledger_entries where principal_id = $1 order by created_at desc, entry_id desc limit $2`,
    [principal_id, limit],
  );
  return {
    principal_id,
    balance_cents: await balanceOf(db(), principal_id),
    currency: "USD",
    label: DEV_LEDGER_LABEL,
    entries: r.rows.map((e) => ({
      entry_id: e.entry_id,
      principal_id: e.principal_id,
      amount_cents: Number(e.amount_cents),
      currency: "USD",
      kind: e.kind,
      lease_id: e.lease_id,
      label: e.label,
      created_at: iso(e.created_at),
    })),
  };
}
