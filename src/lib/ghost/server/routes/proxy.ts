import type { Context, Hono } from "hono";

/**
 * CORS-safe media proxies for public operator media (Caltrans CCTV HLS + stills).
 *
 *   GET /api/v1/proxy/hls?u=<https url of an .m3u8>   rewrites every URI in the playlist back through the proxy
 *   GET /api/v1/proxy/seg?u=<https url>               streams a segment / key / init section
 *   GET /api/v1/proxy/image?u=<https url>             streams a still image (image/* only)
 *
 * STRICT host allowlist (no open proxy / SSRF): wzmedia.dot.ca.gov, cwwp2.dot.ca.gov, plus
 * comma-separated hostnames from env GHOST_PROXY_ALLOW. Only http(s) on default ports, no
 * credentials in URLs, redirects are re-validated against the allowlist hop by hop.
 *
 * Note: as of 2026-10-04 both Caltrans hosts already send `Access-Control-Allow-Origin: *`, so the
 * proxy is not strictly required for CORS; it keeps playback same-origin (works behind tunnels /
 * strict CSPs, never taints the canvas the vision tracker reads) and gives us timeouts + logging.
 */

const DEFAULT_ALLOW = ["wzmedia.dot.ca.gov", "cwwp2.dot.ca.gov"];
const PLAYLIST_MAX_BYTES = 1 * 1024 * 1024;
const SEGMENT_MAX_BYTES = 64 * 1024 * 1024;
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const PLAYLIST_TIMEOUT_MS = 10_000;
const SEGMENT_TIMEOUT_MS = 25_000;
const MAX_REDIRECTS = 3;

export function proxyAllowlist(): string[] {
  const extra = (process.env.GHOST_PROXY_ALLOW ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return [...DEFAULT_ALLOW, ...extra];
}

/** Returns the parsed URL when it is safe to fetch through the proxy, else null. */
export function checkProxyUrl(raw: string | null | undefined): URL | null {
  if (!raw || raw.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  if (u.port && !((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80"))) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!proxyAllowlist().includes(host)) return null;
  return u;
}

/** Coordinator-relative URL that plays an upstream HLS playlist through the proxy. */
export function proxiedHlsUrl(upstream: string, prefix = "/api/v1/proxy"): string {
  return `${prefix}/hls?u=${encodeURIComponent(upstream)}`;
}

export function proxiedImageUrl(upstream: string, prefix = "/api/v1/proxy"): string {
  return `${prefix}/image?u=${encodeURIComponent(upstream)}`;
}

const isPlaylistUrl = (u: string) => /\.m3u8?($|[?#])/i.test(u);

/**
 * Rewrite an HLS playlist so every URI (variant playlists, media segments, keys, maps, renditions,
 * `URI="..."` attributes) resolves to an absolute upstream URL routed back through the proxy.
 * Disallowed hosts are left pointing at a proxy URL that will 403 (never fetched directly).
 */
export function rewritePlaylist(text: string, baseUrl: string, prefix: string): string {
  const wrap = (ref: string) => {
    let abs: string;
    try {
      abs = new URL(ref, baseUrl).toString();
    } catch {
      return ref;
    }
    return `${prefix}/${isPlaylistUrl(abs) ? "hls" : "seg"}?u=${encodeURIComponent(abs)}`;
  };
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#")) {
        return t.includes('URI="') ? t.replace(/URI="([^"]+)"/g, (_m, ref: string) => `URI="${wrap(ref)}"`) : line;
      }
      return wrap(t);
    })
    .join("\n");
}

async function fetchAllowed(start: URL, init: { signal: AbortSignal; headers?: Record<string, string> }): Promise<Response> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(url, {
      redirect: "manual",
      signal: init.signal,
      headers: { "user-agent": "GHOST/0.1 (+public-sources proxy)", ...(init.headers ?? {}) },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      const next = checkProxyUrl(new URL(res.headers.get("location")!, url).toString());
      if (!next) throw new ProxyError(502, "upstream redirected to a host outside the allowlist");
      url = next;
      continue;
    }
    return res;
  }
  throw new ProxyError(502, "too many upstream redirects");
}

class ProxyError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "Range, Content-Type",
  "access-control-expose-headers": "Content-Length, Content-Range, Content-Type, Last-Modified, X-Upstream-Last-Modified",
};

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" },
  });
}

function timeoutSignal(c: Context, ms: number): AbortSignal {
  const signals = [AbortSignal.timeout(ms)];
  const reqSignal = c.req.raw.signal;
  if (reqSignal) signals.push(reqSignal);
  return AbortSignal.any(signals);
}

/** Pass-through body with a hard byte cap. */
function capped(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        seen += chunk.byteLength;
        if (seen > max) {
          ctl.error(new Error("upstream body too large"));
          return;
        }
        ctl.enqueue(chunk);
      },
    }),
  );
}

function prefixFrom(c: Context): string {
  // /api/v1/proxy/hls -> /api/v1/proxy (works wherever the sub-app is mounted)
  return new URL(c.req.url).pathname.replace(/\/(hls|seg|image)\/?$/, "");
}

async function handleHls(c: Context): Promise<Response> {
  const u = checkProxyUrl(c.req.query("u"));
  if (!u) return errorResponse(403, "url not allowed by proxy allowlist");
  try {
    const res = await fetchAllowed(u, { signal: timeoutSignal(c, PLAYLIST_TIMEOUT_MS) });
    if (!res.ok) return errorResponse(res.status === 404 ? 404 : 502, `upstream playlist HTTP ${res.status}`);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > PLAYLIST_MAX_BYTES) return errorResponse(502, "upstream playlist too large");
    const text = await res.text();
    if (text.length > PLAYLIST_MAX_BYTES) return errorResponse(502, "upstream playlist too large");
    if (!text.trimStart().startsWith("#EXTM3U")) return errorResponse(502, "upstream did not return an HLS playlist");
    const body = rewritePlaylist(text, res.url || u.toString(), prefixFrom(c));
    return new Response(body, {
      status: 200,
      headers: { ...CORS, "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-cache, no-store" },
    });
  } catch (e) {
    return upstreamFailure(e);
  }
}

async function handleStream(c: Context, kind: "seg" | "image"): Promise<Response> {
  const u = checkProxyUrl(c.req.query("u"));
  if (!u) return errorResponse(403, "url not allowed by proxy allowlist");
  const headers: Record<string, string> = {};
  const range = c.req.header("range");
  if (range && kind === "seg" && /^bytes=\d*-\d*$/.test(range)) headers.range = range;
  try {
    const res = await fetchAllowed(u, { signal: timeoutSignal(c, kind === "seg" ? SEGMENT_TIMEOUT_MS : PLAYLIST_TIMEOUT_MS), headers });
    if (!res.ok || !res.body) return errorResponse(res.status === 404 ? 404 : 502, `upstream HTTP ${res.status}`);
    const type = res.headers.get("content-type") ?? "application/octet-stream";
    const max = kind === "image" ? IMAGE_MAX_BYTES : SEGMENT_MAX_BYTES;
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > max) return errorResponse(502, "upstream body too large");
    if (kind === "image" && !type.toLowerCase().startsWith("image/")) return errorResponse(502, `upstream is not an image (${type})`);
    // Playlists fetched via /seg (unusual extension) are still rewritten so nested URIs stay proxied.
    if (kind === "seg" && /mpegurl/i.test(type)) {
      const text = await res.text();
      return new Response(rewritePlaylist(text, res.url || u.toString(), prefixFrom(c)), {
        headers: { ...CORS, "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-cache, no-store" },
      });
    }
    const out: Record<string, string> = { ...CORS, "content-type": type, "cache-control": kind === "image" ? "no-cache" : "public, max-age=60" };
    if (len) out["content-length"] = String(len);
    const cr = res.headers.get("content-range");
    if (cr) out["content-range"] = cr;
    const lm = res.headers.get("last-modified");
    if (lm) {
      out["last-modified"] = lm;
      out["x-upstream-last-modified"] = lm;
    }
    return new Response(capped(res.body, max), { status: res.status, headers: out });
  } catch (e) {
    return upstreamFailure(e);
  }
}

function upstreamFailure(e: unknown): Response {
  if (e instanceof ProxyError) return errorResponse(e.status, e.message);
  const err = e as Error;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return errorResponse(504, "upstream timed out");
  return errorResponse(502, `upstream fetch failed: ${err?.message ?? String(e)}`);
}

export function mountProxyRoutes(app: Hono) {
  const preflight = () => new Response(null, { status: 204, headers: { ...CORS, "access-control-max-age": "86400" } });
  app.options("/proxy/hls", preflight);
  app.options("/proxy/seg", preflight);
  app.options("/proxy/image", preflight);
  app.get("/proxy/hls", (c) => handleHls(c));
  app.get("/proxy/seg", (c) => handleStream(c, "seg"));
  app.get("/proxy/image", (c) => handleStream(c, "image"));
}
