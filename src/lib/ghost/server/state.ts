import type { Invocation } from "../contracts";
import type { Db } from "./db";
import type { GhostEvent } from "../contracts";

/** Minimal socket surface we need from `ws` (keeps this module free of the ws import). */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface ConnectorSession {
  connector_id: string;
  owner_id: string;
  socket: SocketLike;
  last_heartbeat: number;
  /** Origin the connector reached us at (used for absolute upload URLs). */
  origin?: string;
  /** Set when heartbeats stopped and its devices were marked offline. */
  timedOut?: boolean;
}

export interface PendingPairingSocket {
  socket: SocketLike;
  origin?: string;
  /** Called on confirm to turn the socket into a connector session. */
  onConfirmed: (connector_id: string, owner_id: string, credential: string) => void;
}

export interface InvocationWaiter {
  resolve: (inv: Invocation) => void;
}

/**
 * All mutable coordinator state lives on globalThis.__ghost so that duplicate module instances
 * (e.g. a Next route handler bundling these files separately, or tsx reloading) share one
 * database handle, one event bus and one set of connector sockets.
 */
export interface GhostState {
  db: Db | null;
  dbPromise: Promise<Db> | null;
  started: Promise<unknown> | null;
  listeners: Set<(e: GhostEvent) => void>;
  /** connector_id -> live socket session */
  connectors: Map<string, ConnectorSession>;
  /** pairing_id -> socket waiting for owner confirmation */
  pendingPairings: Map<string, PendingPairingSocket>;
  /** WebRTC signaling: session_id -> viewer socket */
  signalSessions: Map<string, { socket: SocketLike; principal_id: string; device_id: string }>;
  /** invocation_id -> waiters for a terminal state */
  waiters: Map<string, InvocationWaiter[]>;
  /** rate limiter buckets: key -> timestamps (ms) */
  rate: Map<string, number[]>;
  timers: ReturnType<typeof setInterval>[];
  /** in-flight adapter invocations (for cancellation) */
  aborts: Map<string, AbortController>;
  /** small in-process caches (principal by token, device catalog snapshot) */
  cache: Map<string, { at: number; value: unknown }>;
}

declare global {
  var __ghost: GhostState | undefined;
}

export function S(): GhostState {
  if (globalThis.__ghost && !globalThis.__ghost.cache) globalThis.__ghost.cache = new Map();
  if (!globalThis.__ghost) {
    globalThis.__ghost = {
      db: null,
      dbPromise: null,
      started: null,
      listeners: new Set(),
      connectors: new Map(),
      pendingPairings: new Map(),
      signalSessions: new Map(),
      waiters: new Map(),
      rate: new Map(),
      timers: [],
      aborts: new Map(),
      cache: new Map(),
    };
  }
  return globalThis.__ghost;
}

export function sendTo(socket: SocketLike, msg: unknown): boolean {
  if (socket.readyState !== 1) return false;
  try {
    socket.send(JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}

/** Send a CoordinatorMessage to a connected connector. Returns false if it is not connected. */
export function sendToConnector(connector_id: string, msg: unknown): boolean {
  const s = S().connectors.get(connector_id);
  if (!s) return false;
  return sendTo(s.socket, msg);
}

/** Simple sliding-window rate limit. Returns true if allowed. */
export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const st = S();
  const now = Date.now();
  const arr = (st.rate.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    st.rate.set(key, arr);
    return false;
  }
  arr.push(now);
  st.rate.set(key, arr);
  return true;
}
