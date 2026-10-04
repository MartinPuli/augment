import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { ConnectorKind, ConnectorMessage } from "../contracts";
import { PROTOCOL_VERSION } from "../contracts";
import { principalFromToken, COOKIE_NAME } from "./auth";
import { db, dbReady } from "./db";
import { emit, log } from "./events";
import { handleConnectorResult } from "./invocations";
import { claimPairingCode, connectorByCredential, ownerConnector } from "./pairings";
import {
  getDevice,
  publishFromConnector,
  setConnectorDevicesOnline,
  touchHeartbeat,
  unpublishFromConnector,
} from "./registry";
import { S, sendTo, type ConnectorSession } from "./state";

export const DEVICE_CHANNEL_PATH = "/v1/device-channel";
export const HEARTBEAT_TIMEOUT_MS = 15_000;
const MAX_MESSAGE_BYTES = 1024 * 1024;

interface SocketCtx {
  socket: WebSocket;
  origin: string;
  /** Principal resolved from the ghost_pid cookie on the upgrade request (viewers). */
  cookiePrincipal: string | null;
  connector_id?: string;
  owner_id?: string;
  pairing_id?: string;
  /** signal sessions opened by this socket as a viewer */
  sessions: Set<string>;
}

function originOf(req: IncomingMessage): string {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() ||
    ((req.socket as { encrypted?: boolean }).encrypted ? "https" : "http");
  const host = (req.headers["x-forwarded-host"] as string | undefined) || req.headers.host || `localhost:${process.env.PORT || 3000}`;
  return `${proto}://${host}`;
}

function cookieValue(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function attachConnector(ctx: SocketCtx, connector_id: string, owner_id: string, credential: string) {
  const st = S();
  const prev = st.connectors.get(connector_id);
  if (prev && prev.socket !== ctx.socket) {
    sendTo(prev.socket, { type: "error", message: "superseded by a newer connection" });
    try {
      prev.socket.close(4000, "superseded");
    } catch {
      /* ignore */
    }
  }
  ctx.connector_id = connector_id;
  ctx.owner_id = owner_id;
  const session: ConnectorSession = { connector_id, owner_id, socket: ctx.socket, last_heartbeat: Date.now(), origin: ctx.origin };
  st.connectors.set(connector_id, session);
  sendTo(ctx.socket, { type: "welcome", connector_id, owner_id, credential });
  // Devices come back online on reconnect. Leases are time-based; reconnection never reactivates them.
  void setConnectorDevicesOnline(connector_id, true).catch(() => {});
  void db().query(`update connectors set last_seen = now() where connector_id = $1`, [connector_id]).catch(() => {});
  log("info", `connector ${connector_id} connected`);
}

async function viewerPrincipal(ctx: SocketCtx): Promise<string | null> {
  return ctx.owner_id ?? ctx.cookiePrincipal;
}

async function canView(principal_id: string, device_id: string): Promise<boolean> {
  const d = await getDevice(device_id);
  if (!d) return false;
  if (d.owner_id === principal_id) return true;
  const r = await db().query(
    `select 1 from leases where visitor_id = $1 and state = 'active' and ends_at > now()
       and exists (select 1 from jsonb_array_elements(refs) e where e->>'device_id' = $2) limit 1`,
    [principal_id, device_id],
  );
  return r.rows.length > 0;
}

async function handleMessage(ctx: SocketCtx, msg: ConnectorMessage) {
  const st = S();
  switch (msg.type) {
    case "hello": {
      if (msg.protocol_version && msg.protocol_version !== PROTOCOL_VERSION) {
        sendTo(ctx.socket, { type: "error", message: `unsupported protocol_version ${msg.protocol_version}; expected ${PROTOCOL_VERSION}` });
        return;
      }
      const label = String(msg.label ?? "Connector").slice(0, 80);
      const kind = (msg.connector_kind ?? "other") as ConnectorKind;
      if (msg.credential) {
        const c = await connectorByCredential(msg.credential);
        if (!c) {
          sendTo(ctx.socket, { type: "error", message: "unknown credential; pair again" });
          ctx.socket.close(4001, "unknown credential");
          return;
        }
        attachConnector(ctx, c.connector_id, c.owner_id, msg.credential);
        return;
      }
      if (msg.owner_token) {
        const p = await principalFromToken(msg.owner_token);
        if (!p) {
          sendTo(ctx.socket, { type: "error", message: "invalid owner_token" });
          ctx.socket.close(4001, "invalid owner token");
          return;
        }
        const { connector_id, credential } = await ownerConnector(p.principal_id, label, kind);
        attachConnector(ctx, connector_id, p.principal_id, credential);
        return;
      }
      if (msg.pairing_code) {
        const p = await claimPairingCode(msg.pairing_code, { label, connector_kind: kind, nonce: msg.nonce });
        if (!p) {
          sendTo(ctx.socket, { type: "error", message: "pairing code is invalid, already used or expired" });
          ctx.socket.close(4004, "bad pairing code");
          return;
        }
        ctx.pairing_id = p.pairing_id;
        st.pendingPairings.set(p.pairing_id, {
          socket: ctx.socket,
          origin: ctx.origin,
          onConfirmed: (connector_id, owner_id, credential) => attachConnector(ctx, connector_id, owner_id, credential),
        });
        sendTo(ctx.socket, {
          type: "pending_confirmation",
          pairing_id: p.pairing_id,
          message: "Waiting for the owner to confirm this device in the owner console.",
        });
        return;
      }
      sendTo(ctx.socket, { type: "error", message: "hello requires credential, owner_token or pairing_code" });
      return;
    }
    case "publish": {
      if (!ctx.connector_id || !ctx.owner_id) {
        sendTo(ctx.socket, { type: "error", message: "not confirmed: unconfirmed connectors cannot publish" });
        return;
      }
      try {
        const devices = await publishFromConnector(ctx.connector_id, ctx.owner_id, Array.isArray(msg.devices) ? msg.devices : []);
        sendTo(ctx.socket, { type: "published", devices });
      } catch (e) {
        sendTo(ctx.socket, { type: "error", message: `publish failed: ${(e as Error).message}` });
      }
      return;
    }
    case "unpublish": {
      if (!ctx.connector_id) return;
      await unpublishFromConnector(ctx.connector_id, Array.isArray(msg.local_keys) ? msg.local_keys : []);
      return;
    }
    case "device_status": {
      if (!ctx.connector_id) return;
      await setConnectorDevicesOnline(ctx.connector_id, !!msg.online, msg.local_key);
      return;
    }
    case "heartbeat": {
      if (!ctx.connector_id) return;
      const s = st.connectors.get(ctx.connector_id);
      if (s && s.socket === ctx.socket) {
        s.last_heartbeat = Date.now();
        if (s.timedOut) {
          s.timedOut = false;
          await setConnectorDevicesOnline(ctx.connector_id, true);
        }
      }
      await touchHeartbeat(ctx.connector_id);
      return;
    }
    case "result": {
      if (!ctx.connector_id) return;
      await handleConnectorResult(ctx.connector_id, msg);
      return;
    }
    case "event": {
      if (!ctx.connector_id) return;
      emit({ type: "log", level: "info", message: `device event ${msg.local_key}: ${String(msg.name).slice(0, 80)}`, at: new Date().toISOString() });
      return;
    }
    case "signal": {
      if (typeof msg.session_id !== "string" || !msg.session_id) return;
      if (msg.to === "device") {
        const data = (msg.data ?? {}) as { device_id?: string };
        const device_id = data.device_id ?? st.signalSessions.get(msg.session_id)?.device_id;
        const principal = await viewerPrincipal(ctx);
        if (!device_id || !principal) {
          sendTo(ctx.socket, { type: "error", message: "signal: device_id and an authenticated viewer are required" });
          return;
        }
        const existing = st.signalSessions.get(msg.session_id);
        if (existing && existing.socket !== ctx.socket) {
          sendTo(ctx.socket, { type: "error", message: "signal: session_id belongs to another viewer" });
          return;
        }
        if (!(await canView(principal, device_id))) {
          sendTo(ctx.socket, { type: "error", message: "signal: you need to own this device or hold an active lease on it" });
          return;
        }
        const d = await getDevice(device_id);
        if (!d || !st.connectors.has(d.connector_id)) {
          sendTo(ctx.socket, { type: "error", message: "signal: device is offline" });
          return;
        }
        st.signalSessions.set(msg.session_id, { socket: ctx.socket, principal_id: principal, device_id });
        ctx.sessions.add(msg.session_id);
        st.connectors.get(d.connector_id)!.socket.send(
          JSON.stringify({ type: "signal", session_id: msg.session_id, from: "viewer", device_id, data: msg.data }),
        );
        return;
      }
      if (msg.to === "viewer") {
        const sess = st.signalSessions.get(msg.session_id);
        if (!sess || !ctx.connector_id) return;
        const d = await getDevice(sess.device_id);
        if (!d || d.connector_id !== ctx.connector_id) return;
        sendTo(sess.socket, { type: "signal", session_id: msg.session_id, from: "device", device_id: sess.device_id, data: msg.data });
      }
      return;
    }
    default:
      sendTo(ctx.socket, { type: "error", message: `unknown message type` });
  }
}

function onClose(ctx: SocketCtx) {
  const st = S();
  if (ctx.connector_id) {
    const s = st.connectors.get(ctx.connector_id);
    if (s && s.socket === ctx.socket) {
      st.connectors.delete(ctx.connector_id);
      void setConnectorDevicesOnline(ctx.connector_id, false).catch(() => {});
      log("info", `connector ${ctx.connector_id} disconnected`);
    }
  }
  if (ctx.pairing_id) {
    const p = st.pendingPairings.get(ctx.pairing_id);
    if (p && p.socket === ctx.socket) {
      st.pendingPairings.delete(ctx.pairing_id);
      void db()
        .query(`update pairings set status = 'expired' where pairing_id = $1 and status = 'pending'`, [ctx.pairing_id])
        .catch(() => {});
    }
  }
  for (const sid of ctx.sessions) {
    const s = st.signalSessions.get(sid);
    if (s && s.socket === ctx.socket) st.signalSessions.delete(sid);
  }
}

export function attachSocket(socket: WebSocket, req: IncomingMessage) {
  const ctx: SocketCtx = { socket, origin: originOf(req), cookiePrincipal: null, sessions: new Set() };
  // Serialize message handling per socket so hello completes before publish, etc.
  let chain: Promise<unknown> = (async () => {
    await dbReady();
    const tok = cookieValue(req, COOKIE_NAME);
    if (tok) ctx.cookiePrincipal = (await principalFromToken(tok))?.principal_id ?? null;
  })().catch(() => {});
  socket.on("message", (raw, isBinary) => {
    if (isBinary) {
      sendTo(socket, { type: "error", message: "binary frames are not supported; upload media over HTTP" });
      return;
    }
    const text = raw.toString();
    if (text.length > MAX_MESSAGE_BYTES) {
      sendTo(socket, { type: "error", message: "message too large" });
      return;
    }
    let msg: ConnectorMessage;
    try {
      msg = JSON.parse(text);
    } catch {
      sendTo(socket, { type: "error", message: "invalid JSON" });
      return;
    }
    chain = chain
      .then(() => handleMessage(ctx, msg))
      .catch((e) => {
        console.error("[ghost] device-channel error", e);
        sendTo(socket, { type: "error", message: (e as Error).message ?? "internal error" });
      });
  });
  socket.on("close", () => onClose(ctx));
  socket.on("error", () => {});
}

/** Create the device-channel WebSocket server (noServer: the HTTP server routes upgrades to it). */
export function createDeviceChannel() {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  wss.on("connection", (socket: WebSocket, req: IncomingMessage) => attachSocket(socket, req));
  return {
    wss,
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    },
  };
}

/** Heartbeat watchdog: mark devices offline after 15s without a heartbeat. Also pings connectors. */
export async function heartbeatSweep(): Promise<void> {
  const now = Date.now();
  for (const s of S().connectors.values()) {
    if (!s.timedOut && now - s.last_heartbeat > HEARTBEAT_TIMEOUT_MS) {
      s.timedOut = true;
      await setConnectorDevicesOnline(s.connector_id, false);
      log("warn", `connector ${s.connector_id}: no heartbeat for 15s, devices marked offline`);
    }
  }
}

export function pingConnectors(): void {
  for (const s of S().connectors.values()) sendTo(s.socket, { type: "ping", at: new Date().toISOString() });
}
