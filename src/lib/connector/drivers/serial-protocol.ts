/**
 * GHOST serial line protocol v0.1 — pure, transport-agnostic core (no DOM, no Web Serial).
 *
 * Newline-delimited JSON over a byte stream (default 115200 baud):
 *   host   -> "?\n"
 *   device -> {"ghost":"0.1","name":"Desk Arduino","capabilities":[{"id":"servo.move","kind":"act",
 *              "title":"Move servo","description":"...","params":{"angle":{"type":"number","minimum":0,"maximum":180}},"unit":null}]}
 *   host   -> {"id":"<invocation_id>","cap":"servo.move","args":{"angle":90}}
 *   device -> {"id":"<invocation_id>","ok":true,"value":90,"unit":"deg"} | {"id":"...","ok":false,"error":"..."}
 *
 * Non-JSON lines (boot noise, debug prints) are ignored. Lines longer than MAX_LINE_BYTES are dropped.
 */
import type { CapabilitySpec, InteractionKind, JSONSchema } from "../../ghost/contracts";
import { InvokeError, type CapabilityHandler, type ResultOutput } from "../types";

export const SERIAL_PROTOCOL = "ghost-serial/0.1" as const;
export const DEFAULT_BAUD = 115200;
export const MAX_LINE_BYTES = 4096;
/** Upper bound on how long we wait for a device reply, whatever the invocation deadline. */
export const MAX_REPLY_MS = 10_000;

export interface LineIO {
  /** Write one complete line (must include the trailing "\n"). */
  write(line: string): Promise<void>;
  /** Subscribe to complete received lines (without "\n"/"\r"). Returns an unsubscribe function. */
  onLine(fn: (line: string) => void): () => void;
}

export interface SerialParam {
  type: "number" | "integer" | "string" | "boolean";
  description?: string;
  minimum?: number;
  maximum?: number;
  enum?: (string | number)[];
  maxLength?: number;
  required?: boolean;
  default?: unknown;
}

export interface SerialCapLine {
  id: string;
  kind?: string;
  title?: string;
  description?: string;
  params?: Record<string, SerialParam>;
  required?: string[];
  unit?: string | null;
}

export interface SerialManifestLine {
  ghost: string;
  name: string;
  capabilities: SerialCapLine[];
  /** Optional extras a sketch may report. */
  vendor?: string;
  model?: string;
}

/* ------------------------------------------------------------------ */
/* Small local helpers (kept here so this file only depends on ../types) */
/* ------------------------------------------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nowIso(): string {
  return new Date().toISOString();
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return typeof e === "string" ? e : String(e);
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/* ------------------------------------------------------------------ */
/* Line splitting                                                      */
/* ------------------------------------------------------------------ */

/**
 * Incremental line splitter with a bounded buffer. Feed decoded text chunks with push();
 * complete lines are emitted without "\r\n". A line longer than maxLen is dropped entirely
 * (the remainder up to the next newline is discarded too).
 */
export function createLineSplitter(emit: (line: string) => void, maxLen = MAX_LINE_BYTES) {
  let buf = "";
  let discarding = false;
  let dropped = 0;
  return {
    push(chunk: string) {
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf("\n", start);
        if (nl === -1) {
          const rest = chunk.slice(start);
          if (discarding) return;
          if (buf.length + rest.length > maxLen) {
            buf = "";
            discarding = true;
            dropped++;
            return;
          }
          buf += rest;
          return;
        }
        const part = chunk.slice(start, nl);
        start = nl + 1;
        if (discarding) {
          discarding = false;
          continue;
        }
        if (buf.length + part.length > maxLen) {
          buf = "";
          dropped++;
          continue;
        }
        const line = (buf + part).replace(/\r$/, "");
        buf = "";
        if (line.trim() !== "") emit(line);
      }
    },
    reset() {
      buf = "";
      discarding = false;
    },
    get dropped() {
      return dropped;
    },
  };
}

/** Try to parse a line as a JSON object. Boot noise and arrays → null. */
export function parseJsonLine(line: string): Record<string, unknown> | null {
  const s = line.trim();
  if (!s.startsWith("{") || s.length > MAX_LINE_BYTES) return null;
  try {
    const v: unknown = JSON.parse(s);
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Manifest                                                            */
/* ------------------------------------------------------------------ */

const KINDS: readonly InteractionKind[] = ["observe", "measure", "act", "stream"];
const PARAM_TYPES = ["number", "integer", "string", "boolean"] as const;
const CAP_ID_RE = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/i;

/** Parse a manifest line. Returns null if the line is not a GHOST manifest. */
export function parseManifestLine(line: string): SerialManifestLine | null {
  const o = parseJsonLine(line);
  if (!o || !("ghost" in o)) return null;
  const name = typeof o.name === "string" && o.name.trim() ? clip(o.name.trim(), 64) : "Serial device";
  const caps = Array.isArray(o.capabilities) ? (o.capabilities.filter(isRecord) as unknown as SerialCapLine[]) : [];
  return {
    ghost: String(o.ghost),
    name,
    capabilities: caps,
    vendor: typeof o.vendor === "string" ? clip(o.vendor, 64) : undefined,
    model: typeof o.model === "string" ? clip(o.model, 64) : undefined,
  };
}

function sanitizeParam(name: string, p: unknown): JSONSchema {
  if (!isRecord(p)) throw new Error(`param "${name}" must be an object`);
  const type = p.type;
  if (typeof type !== "string" || !(PARAM_TYPES as readonly string[]).includes(type)) {
    throw new Error(`param "${name}" has unsupported type ${JSON.stringify(type)}`);
  }
  const out: JSONSchema = { type };
  if (typeof p.description === "string") out.description = clip(p.description, 200);
  if (typeof p.minimum === "number" && Number.isFinite(p.minimum)) out.minimum = p.minimum;
  if (typeof p.maximum === "number" && Number.isFinite(p.maximum)) out.maximum = p.maximum;
  if (typeof p.maxLength === "number" && p.maxLength > 0) out.maxLength = Math.min(p.maxLength, 1024);
  if (Array.isArray(p.enum)) {
    const e = p.enum.filter((x) => typeof x === "string" || typeof x === "number").slice(0, 32);
    if (e.length) out.enum = e;
  }
  if (p.default !== undefined && (typeof p.default !== "object" || p.default === null)) out.default = p.default;
  return out;
}

/** Convert one device-declared capability into a GHOST CapabilitySpec. Throws on invalid input (incl. kind "stream"). */
export function serialCapToSpec(c: unknown): CapabilitySpec {
  if (!isRecord(c)) throw new Error("capability must be an object");
  const id = c.id;
  if (typeof id !== "string" || id.length > 64 || !CAP_ID_RE.test(id)) {
    throw new Error(`invalid capability id ${JSON.stringify(id)}`);
  }
  const kindRaw = c.kind === undefined || c.kind === null ? "act" : c.kind;
  if (typeof kindRaw !== "string" || !(KINDS as readonly string[]).includes(kindRaw)) {
    throw new Error(`capability "${id}" has unknown kind ${JSON.stringify(kindRaw)}`);
  }
  const kind = kindRaw as InteractionKind;
  if (kind === "stream") throw new Error(`capability "${id}": kind "stream" is not supported over serial`);

  const properties: Record<string, JSONSchema> = {};
  const required = new Set<string>();
  if (c.params !== undefined && c.params !== null) {
    if (!isRecord(c.params)) throw new Error(`capability "${id}": params must be an object`);
    const keys = Object.keys(c.params);
    if (keys.length > 16) throw new Error(`capability "${id}": too many params`);
    for (const k of keys) {
      if (!/^[a-z_][a-z0-9_]{0,31}$/i.test(k)) throw new Error(`capability "${id}": invalid param name "${k}"`);
      const p = c.params[k];
      properties[k] = sanitizeParam(k, p);
      if (isRecord(p) && p.required === true) required.add(k);
    }
  }
  if (Array.isArray(c.required)) {
    for (const k of c.required) if (typeof k === "string" && k in properties) required.add(k);
  }

  const title = typeof c.title === "string" && c.title.trim() ? clip(c.title.trim(), 80) : id;
  const description =
    typeof c.description === "string" && c.description.trim()
      ? clip(c.description.trim(), 400)
      : `${title} (device-declared over USB serial)`;
  const input_schema: JSONSchema = { type: "object", properties, additionalProperties: false };
  if (required.size) input_schema.required = [...required];

  const spec: CapabilitySpec = {
    capability_id: id,
    kind,
    semantic_type: id,
    title,
    description,
    input_schema,
    verification: kind === "act" ? "acknowledgment" : "observation",
  };
  if (typeof c.unit === "string" && c.unit.trim()) spec.output = { unit: clip(c.unit.trim(), 16) };
  if (kind !== "act") spec.exclusive = false;
  return spec;
}

/** Convert a whole manifest; invalid capabilities are skipped (with a reason), duplicate ids dropped. */
export function manifestToSpecs(m: SerialManifestLine): { specs: CapabilitySpec[]; skipped: string[] } {
  const specs: CapabilitySpec[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const c of m.capabilities.slice(0, 32)) {
    try {
      const s = serialCapToSpec(c);
      if (seen.has(s.capability_id)) {
        skipped.push(`duplicate capability "${s.capability_id}"`);
        continue;
      }
      seen.add(s.capability_id);
      specs.push(s);
    } catch (e) {
      skipped.push(errMsg(e));
    }
  }
  return { specs, skipped };
}

/**
 * Send "?\n" and wait for the first line that is a JSON object with a "ghost" key.
 * Resolves null on timeout. Non-JSON lines are ignored.
 */
export function probeManifest(
  io: LineIO,
  timeoutMs = 2500,
  opts?: { signal?: AbortSignal; onNoise?: (line: string) => void },
): Promise<SerialManifestLine | null> {
  return new Promise<SerialManifestLine | null>((resolve, reject) => {
    let done = false;
    const finish = (v: SerialManifestLine | null, err?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off();
      opts?.signal?.removeEventListener("abort", onAbort);
      if (err !== undefined) reject(err);
      else resolve(v);
    };
    const off = io.onLine((line) => {
      const m = parseManifestLine(line);
      if (m) finish(m);
      else if (!parseJsonLine(line)) opts?.onNoise?.(line);
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
    const onAbort = () => finish(null, new InvokeError("aborted", "failed"));
    if (opts?.signal?.aborted) return onAbort();
    opts?.signal?.addEventListener("abort", onAbort, { once: true });
    io.write("?\n").catch((e) => finish(null, e));
  });
}

/* ------------------------------------------------------------------ */
/* Argument validation                                                 */
/* ------------------------------------------------------------------ */

/**
 * Validate args strictly against the spec's input_schema. Unknown keys, wrong types and
 * out-of-range values are rejected (never clamped: the device trusts what we send).
 * Numeric strings ("90") and "true"/"false" are coerced. Returns the normalized args.
 */
export function validateArgs(spec: CapabilitySpec, args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) args = {};
  if (!isRecord(args)) throw new InvokeError("arguments must be an object", "rejected");
  const props = (spec.input_schema.properties ?? {}) as Record<string, JSONSchema>;
  const required = new Set(Array.isArray(spec.input_schema.required) ? spec.input_schema.required : []);
  const out: Record<string, unknown> = {};

  for (const k of Object.keys(args)) {
    if (!(k in props)) {
      const allowed = Object.keys(props);
      throw new InvokeError(
        `unknown argument "${k}" for ${spec.capability_id}` + (allowed.length ? ` (allowed: ${allowed.join(", ")})` : " (takes no arguments)"),
        "rejected",
      );
    }
  }

  for (const [k, schema] of Object.entries(props)) {
    let v = args[k];
    if (v === undefined || v === null) {
      if (required.has(k)) throw new InvokeError(`argument "${k}" is required`, "rejected");
      continue;
    }
    const type = schema.type;
    if (type === "number" || type === "integer") {
      if (typeof v === "string" && v.trim() !== "") v = Number(v);
      if (typeof v !== "number" || !Number.isFinite(v)) throw new InvokeError(`argument "${k}" must be a number`, "rejected");
      if (type === "integer" && !Number.isInteger(v)) throw new InvokeError(`argument "${k}" must be an integer`, "rejected");
      if (typeof schema.minimum === "number" && v < schema.minimum) {
        throw new InvokeError(`argument "${k}" must be >= ${schema.minimum} (got ${v})`, "rejected");
      }
      if (typeof schema.maximum === "number" && v > schema.maximum) {
        throw new InvokeError(`argument "${k}" must be <= ${schema.maximum} (got ${v})`, "rejected");
      }
    } else if (type === "boolean") {
      if (v === "true") v = true;
      else if (v === "false") v = false;
      if (typeof v !== "boolean") throw new InvokeError(`argument "${k}" must be a boolean`, "rejected");
    } else if (type === "string") {
      if (typeof v !== "string") throw new InvokeError(`argument "${k}" must be a string`, "rejected");
      const max = typeof schema.maxLength === "number" ? schema.maxLength : 256;
      if (v.length > max) throw new InvokeError(`argument "${k}" is longer than ${max} characters`, "rejected");
      if (/[\r\n]/.test(v)) throw new InvokeError(`argument "${k}" must not contain newlines`, "rejected");
    } else {
      throw new InvokeError(`argument "${k}" has an unsupported schema type`, "rejected");
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(v)) {
      throw new InvokeError(`argument "${k}" must be one of ${schema.enum.map((x) => JSON.stringify(x)).join(", ")}`, "rejected");
    }
    out[k] = v;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Invocation                                                          */
/* ------------------------------------------------------------------ */

function sanitizeValue(v: unknown): { value: ResultOutput["value"]; extra?: unknown } {
  if (v === undefined || v === null) return { value: null };
  if (typeof v === "number") return Number.isFinite(v) ? { value: v } : { value: null };
  if (typeof v === "boolean") return { value: v };
  if (typeof v === "string") return { value: clip(v, 1000) };
  return { value: null, extra: v };
}

export interface SerialHandlerOptions {
  /** Cap on reply wait (default MAX_REPLY_MS). */
  maxReplyMs?: number;
  /** Called before each invoke; throw (InvokeError) if the transport is gone. */
  checkOnline?: () => void;
}

/**
 * Build a CapabilityHandler that forwards validated invocations over the line protocol and
 * awaits the matching reply (by id = ctx.invocation_id) until min(ctx deadline, 10 s).
 * Timeout: act → "unknown" (the command may have run), otherwise "failed".
 */
export function createSerialHandler(io: LineIO, specs: CapabilitySpec[], opts: SerialHandlerOptions = {}): CapabilityHandler {
  const byId = new Map(specs.map((s) => [s.capability_id, s]));
  const maxReply = opts.maxReplyMs ?? MAX_REPLY_MS;

  return async (capability_id, args, ctx) => {
    const spec = byId.get(capability_id);
    if (!spec) throw new InvokeError(`unknown capability "${capability_id}"`, "rejected");
    const clean = validateArgs(spec, args);
    opts.checkOnline?.();
    if (ctx.signal.aborted) throw new InvokeError("cancelled before sending", "failed");
    const waitMs = Math.min(ctx.remainingMs(), maxReply);
    if (waitMs <= 0) throw new InvokeError("deadline already passed", "failed");

    const id = ctx.invocation_id;
    const isAct = spec.kind === "act";
    const line = JSON.stringify({ id, cap: capability_id, args: clean }) + "\n";
    if (line.length > MAX_LINE_BYTES) throw new InvokeError("arguments too large for the serial line", "rejected");

    return new Promise<ResultOutput>((resolve, reject) => {
      let done = false;
      let sent = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        off();
        ctx.signal.removeEventListener("abort", onAbort);
        fn();
      };
      const off = io.onLine((raw) => {
        const o = parseJsonLine(raw);
        if (!o || o.id !== id) return;
        if (o.ok === true) {
          const { value, extra } = sanitizeValue(o.value);
          const out: ResultOutput = {
            value,
            captured_at: nowIso(),
            note: isAct
              ? "Device acknowledged the command over USB serial; outcome not independently verified."
              : "Value reported by the device over USB serial.",
          };
          const unit = typeof o.unit === "string" && o.unit ? clip(o.unit, 16) : spec.output?.unit;
          if (unit) out.unit = unit;
          const data: Record<string, unknown> = {};
          if (isRecord(o.data)) Object.assign(data, o.data);
          if (extra !== undefined) data.value = extra;
          if (Object.keys(data).length) out.data = data;
          finish(() => resolve(out));
        } else {
          const msg = typeof o.error === "string" && o.error ? clip(o.error, 300) : "device reported an error";
          finish(() => reject(new InvokeError(msg, "failed")));
        }
      });
      const timer = setTimeout(
        () =>
          finish(() =>
            reject(
              isAct
                ? new InvokeError("no reply from device (the command may or may not have run)", "unknown")
                : new InvokeError("no reply from device", "failed"),
            ),
          ),
        waitMs,
      );
      const onAbort = () =>
        finish(() =>
          reject(
            new InvokeError(
              sent && isAct ? "cancelled after the command was sent; outcome unknown" : "cancelled",
              sent && isAct ? "unknown" : "failed",
            ),
          ),
        );
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      // From here on the bytes may be on the wire: an abort can no longer claim "not run".
      sent = true;
      io.write(line).catch((e) => finish(() => reject(new InvokeError(`serial write failed: ${errMsg(e)}`, "failed"))));
    });
  };
}
