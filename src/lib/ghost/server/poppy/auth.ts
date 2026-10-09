import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { calculateJwkThumbprint, createLocalJWKSet, decodeProtectedHeader, importJWK, jwtVerify, SignJWT, type JSONWebKeySet, type JWTPayload } from "jose";
import { z } from "zod";
import { httpsUrl, publicJson } from "./public-json";

export const JWT_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
export const JWT_CLIENT = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const ALGORITHMS = ["ES256", "RS256", "PS256", "EdDSA"];
const metadataSchema = z.object({ client_id: z.string(), client_name: z.string().max(200), jwks_uri: z.string(), redirect_uris: z.array(z.string()).max(20).default([]), token_endpoint_auth_method: z.literal("private_key_jwt") });
const keySetSchema = z.object({ keys: z.array(z.record(z.string(), z.unknown())).min(1).max(16) });
type Session = { client: string; user: string; principal: string; expires: number };
export type PoppyIdentity = Session & { session_id: string };
export interface PoppyOptions {
  origin: string;
  allowedClients: Set<string>;
  /** Injectable transport/clock for tests. Production always uses pinned public HTTPS. */
  fetchJson?: (url: string) => Promise<unknown>;
  now?: () => number;
}
export class PoppyError extends Error {
  constructor(public code: string, public status: 400 | 401 | 403 | 429 = 400) { super(code); }
}
export class PoppyAuth {
  readonly origin: string;
  readonly tokenEndpoint: string;
  readonly resource: string;
  private key = randomBytes(32);
  private sessions = new Map<string, Session>();
  private replays = new Map<string, number>();
  private rates = new Map<string, { count: number; until: number }>();
  private clients = new Map<string, { until: number; keys: ReturnType<typeof createLocalJWKSet> }>();
  private now: () => number;
  constructor(private options: PoppyOptions) {
    const url = httpsUrl(options.origin);
    if (url.pathname !== "/" || url.search) throw new Error("GHOST_POPPY_ORIGIN must be an HTTPS origin");
    if (options.allowedClients.size > 100) throw new Error("At most 100 registered Poppy clients");
    for (const client of options.allowedClients) httpsUrl(client);
    this.origin = url.origin; this.tokenEndpoint = `${this.origin}/poppy/oauth/token`;
    this.resource = `${this.origin}/poppy/mcp`;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }
  private prune() {
    const now = this.now();
    for (const [key, expiry] of this.replays) if (expiry <= now) this.replays.delete(key);
    for (const [key, s] of this.sessions) if (s.expires <= now) this.sessions.delete(key);
    for (const [key, rate] of this.rates) if (rate.until <= now) this.rates.delete(key);
  }
  private limit(client: string, bucket: string, max: number) {
    const key = `${bucket}:${client}`;
    const rate = this.rates.get(key) ?? { count: 0, until: this.now() + 60 };
    if (rate.count >= max) throw new PoppyError("rate_limited", 429);
    rate.count++; this.rates.set(key, rate);
  }
  private replay(key: string, expiry: number) {
    if (this.replays.has(key)) throw new PoppyError("invalid_grant");
    if (this.replays.size >= 20_000) throw new PoppyError("rate_limited", 429);
    this.replays.set(key, expiry);
  }
  private async clientKeys(client: string) {
    if (!this.options.allowedClients.has(client)) throw new PoppyError("invalid_client", 401);
    const cached = this.clients.get(client);
    if (cached && cached.until > this.now()) return cached.keys;
    try {
      const fetchJson = this.options.fetchJson ?? publicJson;
      const metadata = metadataSchema.parse(await fetchJson(client));
      const origin = httpsUrl(client).origin;
      if (metadata.client_id !== client || httpsUrl(metadata.jwks_uri).origin !== origin || metadata.redirect_uris.some(uri => httpsUrl(uri).origin !== origin)) throw new Error("Metadata origin mismatch");
      const set = keySetSchema.parse(await fetchJson(metadata.jwks_uri));
      if (set.keys.some(k => k.kty === "oct" || ["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some(field => field in k))) throw new Error("Only public signing keys are accepted");
      const keys = createLocalJWKSet(set as JSONWebKeySet);
      this.clients.set(client, { until: this.now() + 60, keys });
      return keys;
    } catch { throw new PoppyError("invalid_client", 401); }
  }
  private async assertion(token: string, client: string, clientAssertion: boolean) {
    const code = clientAssertion ? "invalid_client" : "invalid_grant";
    try {
      const { payload } = await jwtVerify(token, await this.clientKeys(client), { algorithms: ALGORITHMS, issuer: client, audience: this.tokenEndpoint, requiredClaims: ["iss", "sub", "aud", "iat", "exp", "jti"], currentDate: new Date(this.now() * 1000), maxTokenAge: 120 });
      if (payload.aud !== this.tokenEndpoint || typeof payload.sub !== "string" || payload.sub.length < 1 || payload.sub.length > 256 || typeof payload.jti !== "string" || payload.jti.length < 16 || payload.jti.length > 256 || payload.iat! > this.now() || payload.exp! - payload.iat! > 120 || (clientAssertion && payload.sub !== client)) throw new Error("Invalid claims");
      return payload;
    } catch (e) {
      if (e instanceof PoppyError) throw e;
      throw new PoppyError(code, clientAssertion ? 401 : 400);
    }
  }
  private async proof(token: string, method: string, url: string, accessToken?: string) {
    try {
      if (token.length > 8192) throw new Error("Large proof");
      const header = decodeProtectedHeader(token);
      if (header.typ !== "dpop+jwt" || !header.jwk || !header.alg || !ALGORITHMS.includes(header.alg) || header.jwk.kty === "oct" || "d" in header.jwk) throw new Error("Invalid key");
      const { payload } = await jwtVerify(token, await importJWK(header.jwk, header.alg), { algorithms: ALGORITHMS, requiredClaims: ["iat", "jti", "htm", "htu"], currentDate: new Date(this.now() * 1000) });
      if (typeof payload.iat !== "number" || Math.abs(this.now() - payload.iat) > 60 || typeof payload.jti !== "string" || payload.jti.length < 16 || payload.jti.length > 256 || payload.htm !== method || payload.htu !== url) throw new Error("Invalid proof claims");
      if (accessToken && payload.ath !== createHash("sha256").update(accessToken).digest("base64url")) throw new Error("Token hash mismatch");
      const thumbprint = await calculateJwkThumbprint(header.jwk);
      this.replay(`dpop:${thumbprint}:${payload.jti}`, this.now() + 121);
      return thumbprint;
    } catch { throw new PoppyError("invalid_dpop_proof"); }
  }
  async issue(form: URLSearchParams, dpop?: string) {
    this.prune();
    const client = form.get("client_id") ?? "";
    if (!this.options.allowedClients.has(client)) throw new PoppyError("invalid_client", 401);
    this.limit(client, "tokens", 30);
    if (form.get("grant_type") !== JWT_GRANT) throw new PoppyError("unsupported_grant_type");
    if (form.get("client_assertion_type") !== JWT_CLIENT) throw new PoppyError("invalid_client", 401);
    if (form.get("scope")) throw new PoppyError("invalid_scope");
    const resource = form.get("resource");
    if (resource && resource !== this.resource) throw new PoppyError("invalid_target");
    if (!dpop && resource !== this.resource) throw new PoppyError("invalid_target");
    if (dpop && resource === this.resource) throw new PoppyError("invalid_target");
    const clientProof = await this.assertion(form.get("client_assertion") ?? "", client, true);
    const userProof = await this.assertion(form.get("assertion") ?? "", client, false);
    this.replay(`assertion:${client}:${clientProof.jti}`, clientProof.exp!);
    this.replay(`assertion:${client}:${userProof.jti}`, userProof.exp!);
    const thumbprint = dpop ? await this.proof(dpop, "POST", this.tokenEndpoint) : undefined;
    const requestedSession = form.get("session_id");
    const sid = requestedSession || `ses_${randomUUID()}`;
    let session = this.sessions.get(sid);
    if (requestedSession && (!session || session.client !== client || session.user !== userProof.sub)) throw new PoppyError("invalid_session");
    if (!session) {
      if (this.sessions.size >= 1000) throw new PoppyError("rate_limited", 429);
      session = { client, user: userProof.sub!, principal: `poppy:${createHmac("sha256", this.key).update(JSON.stringify([client, userProof.sub])).digest("hex")}`, expires: this.now() + 86400 };
      this.sessions.set(sid, session);
    }
    const expires = Math.min(3600, session.expires - this.now());
    const token = await new SignJWT({ sid, client_id: client, ...(thumbprint ? { cnf: { jkt: thumbprint } } : {}) })
      .setProtectedHeader({ alg: "HS256", typ: "at+jwt" }).setIssuer(this.origin).setAudience(resource ?? this.origin)
      .setSubject(session.principal).setIssuedAt(this.now()).setExpirationTime(this.now() + expires).setJti(randomUUID()).sign(this.key);
    return { access_token: token, token_type: thumbprint ? "DPoP" : "Bearer", expires_in: expires, scope: "", session_id: sid, signed_in: false };
  }
  async authenticate(authorization: string, dpop: string | undefined, method: string, path: string): Promise<PoppyIdentity> {
    this.prune();
    const match = /^(Bearer|DPoP) ([^\s]+)$/i.exec(authorization);
    if (!match || match[2].length > 8192) throw new PoppyError("invalid_token", 401);
    const bearer = match[1].toLowerCase() === "bearer";
    if (bearer && path !== "/poppy/mcp") throw new PoppyError("invalid_token", 401);
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(match[2], this.key, { algorithms: ["HS256"], typ: "at+jwt", issuer: this.origin, audience: bearer ? this.resource : this.origin, currentDate: new Date(this.now() * 1000), requiredClaims: ["exp", "iat", "sub", "sid", "client_id"] }));
    } catch { throw new PoppyError("invalid_token", 401); }
    const s = typeof payload.sid === "string" ? this.sessions.get(payload.sid) : undefined;
    if (!s || !this.options.allowedClients.has(s.client) || s.client !== payload.client_id || s.principal !== payload.sub || (bearer && payload.cnf)) throw new PoppyError("invalid_token", 401);
    if (!bearer) {
      const thumbprint = await this.proof(dpop ?? "", method, `${this.origin}${path}`, match[2]);
      if (!payload.cnf || typeof payload.cnf !== "object" || !("jkt" in payload.cnf) || payload.cnf.jkt !== thumbprint) throw new PoppyError("invalid_dpop_proof");
    }
    this.limit(s.client, "requests", 120);
    return { ...s, session_id: payload.sid as string };
  }
  async revoke(form: URLSearchParams) {
    this.prune();
    if (!form.get("token")) throw new PoppyError("invalid_request");
    const client = form.get("client_id") ?? "";
    if (!this.options.allowedClients.has(client)) throw new PoppyError("invalid_client", 401);
    this.limit(client, "tokens", 30);
    if (form.get("client_assertion_type") !== JWT_CLIENT) throw new PoppyError("invalid_client", 401);
    const proof = await this.assertion(form.get("client_assertion") ?? "", client, true);
    this.replay(`assertion:${client}:${proof.jti}`, proof.exp!);
    // No Account Tokens are issued by this guest-only implementation. RFC 7009 returns 200 for unknown tokens.
  }
}
