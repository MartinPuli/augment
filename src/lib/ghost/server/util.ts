import { createHash, randomBytes } from "node:crypto";
import { customAlphabet } from "nanoid";

const alnum = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 14);
const codeAlphabet = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6);

/** Prefixed random id, e.g. id("dev") -> "dev_k3j2..." */
export function id(prefix: string): string {
  return `${prefix}_${alnum()}`;
}

/** 6-char uppercase pairing code (no ambiguous characters). */
export function pairingCode(): string {
  return codeAlphabet();
}

export function secretToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return new Date(v as string).toISOString();
}

export function isoOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return iso(v);
}

/** Parse a jsonb value that may come back as string (defensive across drivers). */
export function json<T>(v: unknown): T {
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return v as unknown as T;
    }
  }
  return v as T;
}

/** Application error with an HTTP status. Routes and MCP tools map it to their own error shapes. */
export class GhostError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = "error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const bad = (m: string) => new GhostError(400, m, "bad_request");
export const unauthorized = (m = "Not authenticated") => new GhostError(401, m, "unauthorized");
export const forbidden = (m: string) => new GhostError(403, m, "forbidden");
export const notFound = (m: string) => new GhostError(404, m, "not_found");
export const conflict = (m: string) => new GhostError(409, m, "conflict");
export const paymentRequired = (m: string) => new GhostError(402, m, "payment_required");
export const tooMany = (m: string) => new GhostError(429, m, "rate_limited");

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  if (code === "23505") return true;
  const msg = String((e as Error)?.message ?? "");
  return /duplicate key value|unique constraint/i.test(msg);
}

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}
