import { cluster, distributed } from "./cluster";
import type { ConnectorKind, PairingResponse } from "../contracts";
import type { ConnectorInfo, PairingInfo, PairingStatus } from "../client/api-types";
import { db, type Queryable } from "./db";
import { emit, log } from "./events";
import { connectorOnline, S, sendTo } from "./state";
import { conflict, forbidden, id, iso, isoOrNull, notFound, pairingCode, secretToken, sha256 } from "./util";

export const PAIRING_TTL_S = 120;

type PairingRow = {
  pairing_id: string;
  owner_id: string;
  code: string;
  status: PairingStatus;
  label: string | null;
  connector_kind: ConnectorKind | null;
  nonce: string | null;
  connector_id: string | null;
  created_at: unknown;
  expires_at: unknown;
};

function rowToPairing(r: PairingRow): PairingInfo {
  const expired = (r.status === "invited" || r.status === "pending") && new Date(iso(r.expires_at)).getTime() < Date.now();
  return {
    pairing_id: r.pairing_id,
    owner_id: r.owner_id,
    code: r.code,
    status: expired ? "expired" : r.status,
    label: r.label,
    connector_kind: r.connector_kind,
    connector_id: r.connector_id,
    created_at: iso(r.created_at),
    expires_at: iso(r.expires_at),
  };
}

/** POST /api/v1/pairings — owner creates a one-use invitation (6-char code, 2 minutes). */
export async function createPairing(owner_id: string): Promise<PairingResponse> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = pairingCode();
    const clash = await db().query(
      `select 1 from pairings where code = $1 and status in ('invited','pending') and expires_at > now()`,
      [code],
    );
    if (clash.rows.length) continue;
    const pairing_id = id("pair");
    const r = await db().query<PairingRow>(
      `insert into pairings (pairing_id, owner_id, code, status, expires_at)
       values ($1, $2, $3, 'invited', now() + make_interval(secs => $4)) returning *`,
      [pairing_id, owner_id, code, PAIRING_TTL_S],
    );
    return { pairing_id, code, join_path: `/join#code=${code}`, expires_at: iso(r.rows[0].expires_at) };
  }
  throw conflict("could not allocate a pairing code; try again");
}

export async function listPairings(owner_id: string, opts: { pending?: boolean } = {}): Promise<PairingInfo[]> {
  const r = await db().query<PairingRow>(
    `select * from pairings where owner_id = $1 ${opts.pending ? "and status in ('invited','pending') and expires_at > now()" : ""}
     order by created_at desc limit 100`,
    [owner_id],
  );
  return r.rows.map(rowToPairing);
}

/** Device channel: a connector presented a pairing code. Returns the pairing (now pending) or null. */
export async function claimPairingCode(
  code: string,
  hello: { label: string; connector_kind: ConnectorKind; nonce?: string },
): Promise<PairingInfo | null> {
  const r = await db().query<PairingRow>(
    `update pairings set status = 'pending', label = $2, connector_kind = $3, nonce = $4,
            expires_at = greatest(expires_at, now() + make_interval(secs => 120))
     where code = $1 and status = 'invited' and expires_at > now() returning *`,
    [String(code).trim().toUpperCase(), String(hello.label ?? "Unnamed connector").slice(0, 80), hello.connector_kind ?? "other", hello.nonce ?? null],
  );
  if (!r.rows[0]) return null;
  const p = rowToPairing(r.rows[0]);
  emit({ type: "pairing.pending", pairing_id: p.pairing_id, label: p.label ?? "", connector_kind: p.connector_kind ?? "other", owner_id: p.owner_id });
  log("info", `pairing ${p.pairing_id}: "${p.label}" is waiting for owner confirmation`);
  return p;
}

/** Create a connector with a fresh persistent credential (only its hash is stored). */
export async function createConnector(owner_id: string, label: string, connector_kind: ConnectorKind, q: Queryable = db()): Promise<{ connector_id: string; credential: string }> {
  const connector_id = id("con");
  const credential = secretToken("cred");
  await q.query(
    `insert into connectors (connector_id, owner_id, label, connector_kind, credential_hash, last_seen) values ($1,$2,$3,$4,$5, now())`,
    [connector_id, owner_id, label.slice(0, 80), connector_kind, sha256(credential)],
  );
  return { connector_id, credential };
}

/** Owner's own browser (hello with owner_token): reuse its connector by (owner, label, kind), rotate credential. */
export async function ownerConnector(owner_id: string, label: string, connector_kind: ConnectorKind): Promise<{ connector_id: string; credential: string }> {
  const r = await db().query<{ connector_id: string }>(
    `select connector_id from connectors where owner_id = $1 and label = $2 and connector_kind = $3 order by created_at limit 1`,
    [owner_id, label.slice(0, 80), connector_kind],
  );
  if (r.rows[0]) {
    const credential = secretToken("cred");
    await db().query(`update connectors set credential_hash = $2, last_seen = now() where connector_id = $1`, [r.rows[0].connector_id, sha256(credential)]);
    return { connector_id: r.rows[0].connector_id, credential };
  }
  return createConnector(owner_id, label, connector_kind);
}

export async function connectorByCredential(credential: string): Promise<{ connector_id: string; owner_id: string } | null> {
  const r = await db().query<{ connector_id: string; owner_id: string }>(
    `select connector_id, owner_id from connectors where credential_hash = $1`,
    [sha256(credential)],
  );
  return r.rows[0] ?? null;
}

async function requireOwnPairing(owner_id: string, pairing_id: string): Promise<PairingRow> {
  const r = await db().query<PairingRow>(`select * from pairings where pairing_id = $1`, [pairing_id]);
  const p = r.rows[0];
  if (!p) throw notFound("pairing not found");
  if (p.owner_id !== owner_id) throw forbidden("only the owner who created this invitation can confirm it");
  return p;
}

/** Owner confirms a pending pairing: issue a credential and welcome the waiting connector. */
export async function confirmPairing(owner_id: string, pairing_id: string): Promise<{ pairing: PairingInfo; connector_id: string }> {
  const p = await requireOwnPairing(owner_id, pairing_id);
  const info = rowToPairing(p);
  if (info.status !== "pending") throw conflict(`pairing is ${info.status}, not pending confirmation`);
  if (distributed()) {
    const result = await db().tx(async q => {
      const locked = await q.query<PairingRow>(`select * from pairings where pairing_id=$1 for update`, [pairing_id]);
      if (!locked.rows[0] || rowToPairing(locked.rows[0]).status !== "pending") throw conflict("pairing already handled or expired");
      const c = await createConnector(owner_id, p.label ?? "Paired connector", p.connector_kind ?? "other", q);
      const sent = await q.query(`insert into ghost_messages(route_key,instance_id,session_token,payload,expires_at)
        select route_key,instance_id,session_token,$2::jsonb,now()+interval '20 seconds' from ghost_routes
        where route_key=$1 and expires_at>now() returning message_id`, [`pairing:${pairing_id}`,JSON.stringify({type:"confirmed",owner_id,...c})]);
      if (!sent.rowCount) throw conflict("the device disconnected before confirmation; pair again");
      const row = await q.query<PairingRow>(`update pairings set status='confirmed',connector_id=$2 where pairing_id=$1 returning *`, [pairing_id,c.connector_id]);
      return {pairing:rowToPairing(row.rows[0]),connector_id:c.connector_id};
    });
    emit({type:"pairing.confirmed",pairing_id,connector_id:result.connector_id});
    return result;
  }
  const waiting = S().pendingPairings.get(pairing_id);
  if (!waiting || waiting.socket.readyState !== 1) {
    await db().query(`update pairings set status = 'expired' where pairing_id = $1`, [pairing_id]);
    throw conflict("the device disconnected before confirmation; ask it to scan the code again");
  }
  const { connector_id, credential } = await createConnector(owner_id, p.label ?? "Paired connector", p.connector_kind ?? "other");
  const r = await db().query<PairingRow>(
    `update pairings set status = 'confirmed', connector_id = $2 where pairing_id = $1 and status = 'pending' returning *`,
    [pairing_id, connector_id],
  );
  if (!r.rows[0]) throw conflict("pairing already handled");
  S().pendingPairings.delete(pairing_id);
  await waiting.onConfirmed(connector_id, owner_id, credential);
  emit({ type: "pairing.confirmed", pairing_id, connector_id });
  log("info", `pairing ${pairing_id} confirmed -> connector ${connector_id}`);
  return { pairing: rowToPairing(r.rows[0]), connector_id };
}

export async function rejectPairing(owner_id: string, pairing_id: string): Promise<{ pairing: PairingInfo }> {
  await requireOwnPairing(owner_id, pairing_id);
  const r = await db().query<PairingRow>(
    `update pairings set status = 'rejected' where pairing_id = $1 and status in ('invited','pending') returning *`,
    [pairing_id],
  );
  if (distributed() && r.rowCount) await cluster().send(`pairing:${pairing_id}`, {type:"rejected"});
  const waiting = S().pendingPairings.get(pairing_id);
  if (waiting && !distributed()) {
    sendTo(waiting.socket, { type: "error", message: "The owner rejected this pairing request." });
    waiting.socket.close(4003, "pairing rejected");
    S().pendingPairings.delete(pairing_id);
  }
  const row = r.rows[0] ?? (await requireOwnPairing(owner_id, pairing_id));
  return { pairing: rowToPairing(row) };
}

export async function listConnectors(owner_id: string): Promise<ConnectorInfo[]> {
  const r = await db().query<{ connector_id: string; owner_id: string; label: string; connector_kind: ConnectorKind; last_seen: unknown; created_at: unknown }>(
    `select connector_id, owner_id, label, connector_kind, last_seen, created_at from connectors where owner_id = $1 order by created_at desc`,
    [owner_id],
  );
  return Promise.all(r.rows.map(async (c) => ({
    connector_id: c.connector_id,
    owner_id: c.owner_id,
    label: c.label,
    connector_kind: c.connector_kind,
    online: await connectorOnline(c.connector_id),
    last_seen: isoOrNull(c.last_seen),
    created_at: iso(c.created_at),
  })));
}
