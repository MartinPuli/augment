/**
 * Kernel (kernel.sh) cloud browsers: turn a public web page into an image observation.
 *
 * "Authorized web interaction" only: we navigate to a public http(s) page, wait, and take a
 * screenshot. We never type credentials, never load profiles/vaults, never enable stealth mode
 * (which turns on Kernel's CAPTCHA solver), and never try to get past logins or paywalls.
 *
 * One shared browser session is reused across calls (serialized with a mutex) and closed after
 * KERNEL_IDLE_CLOSE_S of inactivity (default 90 s) or KERNEL_MAX_SESSION_S of age (default 600 s),
 * and Kernel itself kills it after timeout_seconds of inactivity, so credits are not burned.
 */
import Kernel from "@onkernel/sdk";
import { GhostError } from "../util";
import { assertPublicHttpUrl, createMutex, describeError, env, PartnerError, requireEnv, singleton } from "./common";

export const KERNEL_SETUP = "set KERNEL_API_KEY in .env.local (https://dashboard.onkernel.com)";
export const MAX_WAIT_MS = 8000;
export const DEFAULT_WAIT_MS = 2500;
const VIEWPORT = { width: 1280, height: 720 };

export function kernelConfigured(): boolean {
  return !!env("KERNEL_API_KEY");
}

interface Session {
  session_id: string;
  live_view_url: string | null;
  created_at: number;
  last_used: number;
  headless: boolean;
}

interface KernelState {
  client: Kernel | null;
  clientKey: string | null;
  session: Session | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  run: <T>(fn: () => Promise<T>) => Promise<T>;
}

const K = () =>
  singleton<KernelState>("kernel", () => ({
    client: null,
    clientKey: null,
    session: null,
    idleTimer: null,
    run: createMutex(),
  }));

function client(): Kernel {
  const key = requireEnv("Kernel", "KERNEL_API_KEY");
  const st = K();
  const base = env("KERNEL_BASE_URL"); // optional override (proxies, tests); SDK default otherwise
  if (!st.client || st.clientKey !== `${key}|${base}`) {
    st.client = new Kernel({ apiKey: key, ...(base ? { baseURL: base } : {}), maxRetries: 1, timeout: 45_000 });
    st.clientKey = `${key}|${base}`;
    st.session = null; // a session belongs to the previous account/endpoint
  }
  return st.client;
}

const idleCloseMs = () => Math.max(15, Number(env("KERNEL_IDLE_CLOSE_S") ?? 90)) * 1000;
const maxSessionMs = () => Math.max(60, Number(env("KERNEL_MAX_SESSION_S") ?? 600)) * 1000;

function scheduleIdleClose() {
  const st = K();
  if (st.idleTimer) clearTimeout(st.idleTimer);
  st.idleTimer = setTimeout(() => {
    void closeBrowser("idle").catch(() => {});
  }, idleCloseMs());
  (st.idleTimer as { unref?: () => void }).unref?.();
}

async function ensureSession(): Promise<Session> {
  const st = K();
  const now = Date.now();
  if (st.session && now - st.session.created_at < maxSessionMs()) return st.session;
  if (st.session) await closeSessionUnlocked("max age");
  const headless = env("KERNEL_HEADLESS") === "1";
  try {
    const b = await client().browsers.create({
      headless, // headful sessions expose a live view URL the UI can embed
      stealth: false, // never enable the CAPTCHA solver / stealth proxy
      timeout_seconds: Math.max(30, Math.min(600, Number(env("KERNEL_TIMEOUT_S") ?? 120))),
      viewport: VIEWPORT,
      tags: { app: "ghost", purpose: "web-observe" },
    });
    st.session = {
      session_id: b.session_id,
      live_view_url: b.browser_live_view_url ?? null,
      created_at: now,
      last_used: now,
      headless,
    };
    return st.session;
  } catch (e) {
    throw new PartnerError("Kernel", `could not create a browser: ${describeError(e)}`);
  }
}

async function closeSessionUnlocked(reason: string): Promise<string | null> {
  const st = K();
  const s = st.session;
  st.session = null;
  if (st.idleTimer) clearTimeout(st.idleTimer);
  st.idleTimer = null;
  if (!s) return null;
  try {
    await client().browsers.deleteByID(s.session_id);
  } catch (e) {
    // Already gone (Kernel's own inactivity timeout) is fine.
    console.warn(`[ghost/kernel] close ${s.session_id} (${reason}): ${describeError(e)}`);
  }
  return s.session_id;
}

/** Close the shared browser (if any). Safe to call repeatedly. */
export function closeBrowser(reason = "requested"): Promise<{ closed: boolean; session_id: string | null }> {
  if (!kernelConfigured()) return Promise.resolve({ closed: false, session_id: null });
  return K().run(async () => {
    const id = await closeSessionUnlocked(reason);
    return { closed: !!id, session_id: id };
  });
}

export function kernelStatus() {
  const s = K().session;
  return {
    configured: kernelConfigured(),
    session: s
      ? {
          session_id: s.session_id,
          live_view_url: s.live_view_url,
          headless: s.headless,
          created_at: new Date(s.created_at).toISOString(),
          last_used: new Date(s.last_used).toISOString(),
          idle_close_s: Math.round(idleCloseMs() / 1000),
        }
      : null,
  };
}

export interface PageObservation {
  bytes: Uint8Array;
  content_type: "image/jpeg" | "image/png";
  captured_at: string;
  requested_url: string;
  final_url: string;
  title: string | null;
  http_status: number | null;
  live_view_url: string | null;
  session_id: string;
  wait_ms: number;
  focused_media: FocusedMedia | null;
}

/** Code executed by Kernel's server-side Playwright runner (has `page`, `context`, `browser`). */
export function playwrightCode(url: string, waitMs: number, fullPage: boolean): string {
  // All values are JSON-encoded literals: no string interpolation of untrusted text into code.
  return `
const target = ${JSON.stringify(url)};
const waitMs = ${JSON.stringify(waitMs)};
const fullPage = ${JSON.stringify(fullPage)};
page.on("dialog", (d) => d.dismiss().catch(() => {}));
let status = null;
try {
  const resp = await page.goto(target, { waitUntil: "domcontentloaded", timeout: 20000 });
  status = resp ? resp.status() : null;
} catch (e) {
  return { ok: false, error: "navigation failed: " + String(e && e.message || e).slice(0, 200) };
}
if (waitMs > 0) await page.waitForTimeout(waitMs);
// Bring the page's main live media (video / player iframe / large image) into view, so the
// screenshot shows the camera rather than the site header. Scrolling only: no clicks, no typing.
let focused = null;
if (!fullPage) {
  try {
    focused = await page.evaluate(() => {
      const AD = /doubleclick|googlesyndication|adservice|amazon-adsystem|adnxs|taboola|outbrain|facebook[.]com[/]plugins/i;
      let best = null;
      let bestScore = 0;
      for (const el of Array.from(document.querySelectorAll("video, iframe, img, canvas, embed, object"))) {
        const r = el.getBoundingClientRect();
        if (r.width < 320 || r.height < 180) continue;
        const st = getComputedStyle(el);
        if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) continue;
        const src = el.currentSrc || el.src || el.data || "";
        if (AD.test(src)) continue;
        if (el.tagName === "IMG" && /logo|sprite|icon|avatar|banner/i.test(src)) continue;
        const t = el.tagName;
        const w = t === "VIDEO" ? 1.6 : t === "IFRAME" || t === "EMBED" || t === "OBJECT" ? 1.3 : t === "CANVAS" ? 1.2 : 1;
        const score = r.width * r.height * w;
        if (score > bestScore) { bestScore = score; best = el; }
      }
      if (!best) return null;
      best.scrollIntoView({ block: "center", inline: "center" });
      const r = best.getBoundingClientRect();
      let host = null;
      try { host = new URL(best.currentSrc || best.src || best.data || location.href, location.href).hostname; } catch {}
      return { tag: best.tagName.toLowerCase(), width: Math.round(r.width), height: Math.round(r.height), src_host: host };
    });
    if (focused) await page.waitForTimeout(1500);
  } catch {}
}
let title = null;
try { title = (await page.title()).slice(0, 200); } catch {}
const capturedAt = new Date().toISOString();
let jpeg_b64 = null;
let shot_error = null;
try {
  const shot = await page.screenshot({ type: "jpeg", quality: 72, fullPage, timeout: 15000 });
  jpeg_b64 = (typeof Buffer !== "undefined" ? Buffer.from(shot) : shot).toString("base64");
} catch (e) {
  shot_error = String(e && e.message || e).slice(0, 200);
}
return { ok: true, status, final_url: page.url(), title, captured_at: capturedAt, jpeg_b64, shot_error, focused };
`;
}

type ExecResult = {
  ok?: boolean;
  error?: string;
  status?: number | null;
  final_url?: string;
  title?: string | null;
  captured_at?: string;
  jpeg_b64?: string | null;
  shot_error?: string | null;
  focused?: FocusedMedia | null;
};

/** The media element the screenshot was centred on (null if none was found). */
export interface FocusedMedia {
  tag: string;
  width: number;
  height: number;
  src_host: string | null;
}

function isGone(e: unknown): boolean {
  const s = (e as { status?: number })?.status;
  return s === 404 || s === 410;
}

/**
 * Navigate the shared Kernel browser to `url`, wait `wait_ms`, screenshot. Serialized.
 * Throws GhostError(400) for bad URLs, NotConfiguredError when no key, PartnerError for Kernel failures.
 */
export async function observePage(
  rawUrl: string,
  opts: { wait_ms?: number; full_page?: boolean; signal?: AbortSignal } = {},
): Promise<PageObservation> {
  client(); // throws NotConfiguredError early
  const u = await assertPublicHttpUrl(rawUrl);
  const waitMs = Math.max(0, Math.min(MAX_WAIT_MS, Math.round(Number(opts.wait_ms ?? DEFAULT_WAIT_MS)) || 0));
  const fullPage = opts.full_page === true; // contract: default false; full-page shots stay opt-in
  return K().run(async () => {
    if (opts.signal?.aborted) throw new GhostError(499, "cancelled", "cancelled");
    let attempt = 0;
    for (;;) {
      const s = await ensureSession();
      try {
        const res = await client().browsers.playwright.execute(
          s.session_id,
          { code: playwrightCode(u.toString(), waitMs, fullPage), timeout_sec: 45 },
          { signal: opts.signal },
        );
        s.last_used = Date.now();
        scheduleIdleClose();
        if (!res.success) throw new PartnerError("Kernel", `playwright execution failed: ${String(res.error ?? res.stderr ?? "").slice(0, 300)}`);
        const r = (res.result ?? {}) as ExecResult;
        if (r.ok === false) throw new PartnerError("Kernel", r.error ?? "navigation failed", 502);
        // Re-check where the browser ended up (redirects) before we keep the evidence.
        const finalUrl = r.final_url || u.toString();
        try {
          await assertPublicHttpUrl(finalUrl, "final page url");
        } catch {
          throw new GhostError(400, "page redirected to a non-public address; screenshot discarded", "ssrf_blocked");
        }
        let bytes: Uint8Array;
        let content_type: "image/jpeg" | "image/png" = "image/jpeg";
        let captured_at = r.captured_at && !Number.isNaN(Date.parse(r.captured_at)) ? new Date(r.captured_at).toISOString() : "";
        const decoded =
          typeof r.jpeg_b64 === "string" && r.jpeg_b64.length > 100 && /^[A-Za-z0-9+/=\s]+$/.test(r.jpeg_b64)
            ? new Uint8Array(Buffer.from(r.jpeg_b64, "base64"))
            : null;
        if (decoded && decoded[0] === 0xff && decoded[1] === 0xd8) {
          bytes = decoded; // JPEG magic bytes check
        } else {
          // Fallback: Kernel's native screenshot API (PNG of the current viewport).
          captured_at = new Date().toISOString();
          const resp = await client().browsers.computer.captureScreenshot(s.session_id);
          bytes = new Uint8Array(await resp.arrayBuffer());
          content_type = "image/png";
        }
        if (!captured_at) captured_at = new Date().toISOString();
        return {
          bytes,
          content_type,
          captured_at,
          requested_url: u.toString(),
          final_url: finalUrl,
          title: typeof r.title === "string" ? r.title : null,
          http_status: typeof r.status === "number" ? r.status : null,
          live_view_url: s.live_view_url,
          session_id: s.session_id,
          wait_ms: waitMs,
          focused_media: r.focused && typeof r.focused === "object" ? r.focused : null,
        };
      } catch (e) {
        if (attempt === 0 && isGone(e)) {
          // Kernel already reaped the session (inactivity timeout): start a fresh one once.
          attempt++;
          K().session = null;
          continue;
        }
        if (e instanceof GhostError || e instanceof PartnerError) throw e;
        throw new PartnerError("Kernel", describeError(e));
      }
    }
  });
}
