/* eslint-disable @typescript-eslint/no-explicit-any -- test mock: loosely typed on purpose */
/**
 * GHOST mock coordinator for connector development (device channel + HTTP control API).
 *
 *   pnpm exec tsx scripts/conn-ws-mock.ts
 *
 * Env: MOCK_PORT (3200), MOCK_CONFIRM_MS (800), MOCK_MANUAL_CONFIRM=1, MOCK_UPLOAD_DIR.
 * Control API: GET /devices, POST /invoke, POST /upload/:invocation_id, GET /uploads/:observation_id,
 *              POST /revoke, POST /cancel, POST /pairings/:id/confirm, GET /pairings.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type {
  ConnectorMessage,
  CoordinatorMessage,
  DeviceManifest,
} from "../src/lib/ghost/contracts";

const PORT = Number(process.env.MOCK_PORT || 3200);
const CONFIRM_MS = Number(process.env.MOCK_CONFIRM_MS || 800);
const MANUAL = process.env.MOCK_MANUAL_CONFIRM === "1";
const UPLOAD_DIR = process.env.MOCK_UPLOAD_DIR || "";

const rid = (n = 10) => randomBytes(n).toString("base64url").slice(0, n);
const now = () => new Date().toISOString();
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a);
const brief = (m: unknown) => {
  const s = JSON.stringify(m);
  return s.length > 400 ? s.slice(0, 400) + "…" : s;
};

type Conn = {
  ws: WebSocket;
  connector_id: string | null;
  label: string;
  kind: string;
  devices: Map<string, DeviceManifest & { device_id: string }>;
  last_heartbeat: string | null;
};
type Pending = { resolve: (r: unknown) => void; timer: NodeJS.Timeout };

const conns = new Set<Conn>();
const devices = new Map<string, { conn: Conn; dev: DeviceManifest & { device_id: string } }>(); // survives disconnects
const credentials = new Map<string, string>(); // credential -> connector_id (stable across reconnects)
const pairings = new Map<string, { conn: Conn; code: string; confirmed: boolean }>();
const pendingResults = new Map<string, Pending>();
const uploadTokens = new Map<string, string>(); // invocation_id -> token
const uploads = new Map<string, { body: Buffer; type: string; captured_at: string | null; invocation_id: string }>();
const viewers = new Map<string, WebSocket>(); // signal session_id -> viewer socket

function send(ws: WebSocket, msg: CoordinatorMessage | Record<string, unknown>) {
  if (ws.readyState !== WebSocket.OPEN) return;
  log("->", brief(msg));
  ws.send(JSON.stringify(msg));
}

function welcome(conn: Conn, credential?: string) {
  const cred = credential || `cred_${rid(16)}`;
  conn.connector_id = credentials.get(cred) || `conn_${rid(8)}`;
  credentials.set(cred, conn.connector_id);
  send(conn.ws, { type: "welcome", connector_id: conn.connector_id, owner_id: "own_mock", credential: cred });
}

const findDevice = (device_id: string) => devices.get(device_id) || null;

function onMessage(conn: Conn, msg: ConnectorMessage | Record<string, any>) {
  const m = msg as any;
  if (m.type !== "heartbeat") log("<-", conn.connector_id || "?", brief(m));
  if (m.type === "hello") {
    conn.label = String(m.label || "");
    conn.kind = String(m.connector_kind || "");
    if (m.protocol_version !== "ghost/0.1") {
      send(conn.ws, { type: "error", message: `unsupported protocol_version ${m.protocol_version}` });
      return conn.ws.close(4000, "bad protocol");
    }
    if (typeof m.credential === "string" && m.credential.startsWith("cred_")) return welcome(conn, m.credential);
    if (typeof m.owner_token === "string" && m.owner_token) return welcome(conn);
    if (typeof m.pairing_code === "string" && m.pairing_code) {
      const pairing_id = `pair_${rid(8)}`;
      pairings.set(pairing_id, { conn, code: m.pairing_code, confirmed: false });
      send(conn.ws, {
        type: "pending_confirmation",
        pairing_id,
        message: MANUAL
          ? `Mock: confirm with POST /pairings/${pairing_id}/confirm`
          : `Mock: auto-confirming in ${CONFIRM_MS} ms`,
      });
      if (!MANUAL) setTimeout(() => confirmPairing(pairing_id), CONFIRM_MS);
      return;
    }
    send(conn.ws, { type: "error", message: "hello needs credential, pairing_code or owner_token" });
    return conn.ws.close(4001, "unauthorized");
  }
  if (!conn.connector_id) {
    send(conn.ws, { type: "error", message: "not authenticated" });
    return;
  }
  switch (m.type) {
    case "publish": {
      const out: { local_key: string; device_id: string; status: "configured" }[] = [];
      for (const d of (m.devices || []) as DeviceManifest[]) {
        const device_id = `dev_${String(d.local_key).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
        conn.devices.set(d.local_key, { ...d, device_id });
        devices.set(device_id, { conn, dev: conn.devices.get(d.local_key)! });
        out.push({ local_key: d.local_key, device_id, status: "configured" });
      }
      return send(conn.ws, { type: "published", devices: out });
    }
    case "unpublish":
      for (const k of m.local_keys || []) {
        const d = conn.devices.get(k);
        if (d) devices.delete(d.device_id);
        conn.devices.delete(k);
      }
      return;
    case "heartbeat":
      conn.last_heartbeat = m.at || now();
      return;
    case "result": {
      const p = pendingResults.get(m.invocation_id);
      if (p) {
        clearTimeout(p.timer);
        pendingResults.delete(m.invocation_id);
        p.resolve(m);
      }
      return;
    }
    case "signal": {
      if (m.to === "device") {
        const device_id = m.data?.device_id;
        const found = device_id ? findDevice(device_id) : null;
        if (!found) return send(conn.ws, { type: "error", message: `signal: unknown device ${device_id}` });
        viewers.set(m.session_id, conn.ws);
        return send(found.conn.ws, { type: "signal", session_id: m.session_id, from: "viewer", device_id, data: m.data });
      }
      if (m.to === "viewer") {
        const v = viewers.get(m.session_id);
        const device_id = [...conn.devices.values()][0]?.device_id || "";
        if (!v) return send(conn.ws, { type: "error", message: `signal: unknown session ${m.session_id}` });
        return send(v, { type: "signal", session_id: m.session_id, from: "device", device_id, data: m.data });
      }
      return;
    }
    default:
      return; // device_status / event: already logged
  }
}

function confirmPairing(id: string) {
  const p = pairings.get(id);
  if (!p || p.confirmed) return false;
  p.confirmed = true;
  welcome(p.conn);
  return true;
}

/* ---------------- HTTP control API ---------------- */

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body, null, 2));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const p = url.pathname;
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization, content-type, x-captured-at",
        "access-control-allow-methods": "GET, POST, OPTIONS",
      });
      return res.end();
    }
    if (req.method === "GET" && p === "/devices") {
      const list = [...devices.values()].map(({ conn: c, dev: d }) => ({
        device_id: d.device_id,
        local_key: d.local_key,
        connector_id: c.connector_id,
        name: d.name,
        capabilities: d.capabilities.map((x) => x.capability_id),
        online: c.ws.readyState === WebSocket.OPEN,
        last_heartbeat: c.last_heartbeat,
      }));
      return json(res, 200, url.searchParams.has("full") ? [...devices.values()].map((x) => x.dev) : list);
    }
    if (req.method === "GET" && p === "/pairings")
      return json(res, 200, [...pairings].map(([id, v]) => ({ pairing_id: id, code: v.code, label: v.conn.label, confirmed: v.confirmed })));
    let mm = p.match(/^\/pairings\/([^/]+)\/confirm$/);
    if (req.method === "POST" && mm) return json(res, confirmPairing(mm[1]) ? 200 : 404, { ok: pairings.has(mm[1]) });

    if (req.method === "POST" && p === "/invoke") {
      const b = JSON.parse((await readBody(req)).toString() || "{}");
      const found = findDevice(b.device_id);
      if (!found) return json(res, 404, { error: `unknown device ${b.device_id}` });
      if (found.conn.ws.readyState !== WebSocket.OPEN) return json(res, 409, { error: `device ${b.device_id} offline` });
      const invocation_id: string = b.invocation_id || `inv_${rid(10)}`;
      const deadline_ms = Number(b.deadline_ms ?? 15000);
      const token = uploadTokens.get(invocation_id) || `upl_${rid(16)}`;
      uploadTokens.set(invocation_id, token);
      const invoke: CoordinatorMessage = {
        type: "invoke",
        invocation_id,
        device_id: found.dev.device_id,
        local_key: found.dev.local_key,
        capability_id: b.capability_id,
        arguments: b.arguments ?? {},
        lease_id: b.lease_id ?? null,
        lease_revision: 1,
        deadline: new Date(Date.now() + deadline_ms).toISOString(),
        upload: { url: `http://localhost:${PORT}/upload/${invocation_id}`, token },
      };
      const result = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingResults.delete(invocation_id);
          resolve({ timeout: true });
        }, Math.max(0, deadline_ms) + 2000);
        pendingResults.set(invocation_id, { resolve, timer });
        send(found.conn.ws, invoke);
      });
      return json(res, 200, { invoke, result });
    }
    mm = p.match(/^\/upload\/([^/]+)$/);
    if (req.method === "POST" && mm) {
      const inv = mm[1];
      const expected = uploadTokens.get(inv);
      if (!expected || req.headers.authorization !== `Bearer ${expected}`) return json(res, 401, { error: "bad upload token" });
      const body = await readBody(req);
      const type = String(req.headers["content-type"] || "application/octet-stream");
      const captured_at = (req.headers["x-captured-at"] as string) || null;
      const observation_id = `obs_${rid(10)}`;
      uploads.set(observation_id, { body, type, captured_at, invocation_id: inv });
      log("upload", inv, observation_id, `${body.length}B`, type, "captured_at=" + captured_at);
      if (UPLOAD_DIR) {
        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        const ext = type.includes("jpeg") ? ".jpg" : type.includes("png") ? ".png" : ".bin";
        fs.writeFileSync(path.join(UPLOAD_DIR, observation_id + ext), body);
      }
      return json(res, 200, { observation_id });
    }
    mm = p.match(/^\/uploads\/([^/]+)$/);
    if (req.method === "GET" && mm) {
      const u = uploads.get(mm[1]);
      if (!u) return json(res, 404, { error: "not found" });
      res.writeHead(200, { "content-type": u.type, "access-control-allow-origin": "*" });
      return res.end(u.body);
    }
    if (req.method === "POST" && (p === "/revoke" || p === "/cancel")) {
      const b = JSON.parse((await readBody(req)).toString() || "{}");
      let sent = 0;
      for (const c of conns) {
        if (!c.connector_id) continue;
        if (p === "/revoke") {
          const ids: string[] = b.device_ids || [];
          const owns = [...c.devices.values()].some((d) => ids.length === 0 || ids.includes(d.device_id));
          if (!owns) continue;
          send(c.ws, { type: "revoke", lease_id: b.lease_id, device_ids: ids });
        } else send(c.ws, { type: "cancel", invocation_id: b.invocation_id });
        sent++;
      }
      return json(res, 200, { ok: true, sent });
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: String(e) });
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (new URL(req.url || "/", "http://x").pathname !== "/v1/device-channel") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
wss.on("connection", (ws, req) => {
  const conn: Conn = { ws, connector_id: null, label: "", kind: "", devices: new Map(), last_heartbeat: null };
  conns.add(conn);
  log("ws open", req.socket.remoteAddress);
  ws.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: "error", message: "invalid JSON" });
    }
    onMessage(conn, msg);
  });
  ws.on("close", (code) => {
    log("ws close", conn.connector_id, code);
    conns.delete(conn);
  });
});
setInterval(() => {
  for (const c of conns) if (c.connector_id) send(c.ws, { type: "ping", at: now() });
}, 20000);

server.listen(PORT, () => log(`GHOST mock coordinator on http://localhost:${PORT} (ws /v1/device-channel)`));
