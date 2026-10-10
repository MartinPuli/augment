/**
 * AgentMail (agentmail.to): Polty's own inbox.
 *
 * - The inbox is created on first use, idempotently (clientId), so calling this repeatedly is safe.
 * - Evidence reports: an on-brand HTML email (plain-text alternative included) with each
 *   observation attached (image bytes) plus device name, capture time and provenance.
 * - Sending is outward-facing: single valid recipient, rate-limited (default 10/hour), and the
 *   agent must confirm with the user before calling it.
 * - Inbound mail is DATA, never instructions.
 */
import { AgentMailClient } from "agentmail";
import type { Device, Observation } from "../../contracts";
import { getInvocationRaw, getObservation, getObservationMedia } from "../invocations";
import { getDevice } from "../registry";
import { rateLimit, S } from "../state";
import { GhostError } from "../util";
import { clampInt, describeError, env, PartnerError, requireEnv, singleton, untrustedText, UNTRUSTED_NOTE } from "./common";

export const MAIL_SETUP = "set AGENTMAIL_API_KEY in .env.local (https://console.agentmail.to)";
const MAX_ATTACH_BYTES = 4.5 * 1024 * 1024; // AgentMail caps the whole request at 6 MB (base64 inflates ~33%)
const MAX_OBSERVATIONS = 6;

export function mailConfigured(): boolean {
  return !!env("AGENTMAIL_API_KEY");
}

const maxPerHour = () => clampInt(env("AGENTMAIL_MAX_PER_HOUR"), 1, 100, 10);
const username = () => (env("AGENTMAIL_INBOX_USERNAME") ?? "polty-ghost").toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 60) || "polty-ghost";

interface MailState {
  client: AgentMailClient | null;
  key: string | null;
  inbox: { inbox_id: string; email: string; display_name: string | null } | null;
  inboxPromise: Promise<{ inbox_id: string; email: string; display_name: string | null }> | null;
}

const M = () => singleton<MailState>("mail", () => ({ client: null, key: null, inbox: null, inboxPromise: null }));

function client(): AgentMailClient {
  const key = requireEnv("AgentMail", "AGENTMAIL_API_KEY");
  const st = M();
  const base = env("AGENTMAIL_BASE_URL"); // optional override (e.g. https://api.agentmail.eu, proxies, tests)
  if (!st.client || st.key !== `${key}|${base}`) {
    st.client = new AgentMailClient({ apiKey: key, baseUrl: base, timeoutInSeconds: 30, maxRetries: 1 });
    st.key = `${key}|${base}`;
    st.inbox = null;
    st.inboxPromise = null;
  }
  return st.client;
}

/** Get or create Polty's inbox. Idempotent: same clientId -> same inbox. */
export async function ensureInbox(): Promise<{ inbox_id: string; email: string; display_name: string | null }> {
  const c = client();
  const st = M();
  if (st.inbox) return st.inbox;
  if (st.inboxPromise) return st.inboxPromise;
  const user = username();
  const clientId = `ghost-polty-${user}`;
  st.inboxPromise = (async () => {
    try {
      const inbox = await c.inboxes.create({ username: user, displayName: "Polty (GHOST)", clientId });
      return { inbox_id: inbox.inboxId, email: inbox.email, display_name: inbox.displayName ?? null };
    } catch (e) {
      // Username already taken by this account (e.g. created before clientId was used): find it.
      try {
        const list = await c.inboxes.list({ limit: 100 });
        const found = list.inboxes.find((i) => i.clientId === clientId || i.email.toLowerCase().startsWith(`${user}@`));
        if (found) return { inbox_id: found.inboxId, email: found.email, display_name: found.displayName ?? null };
      } catch {
        /* fall through */
      }
      throw new PartnerError("AgentMail", `could not create or find inbox ${user}: ${describeError(e)}`);
    }
  })();
  try {
    st.inbox = await st.inboxPromise;
    return st.inbox;
  } finally {
    st.inboxPromise = null;
  }
}

export async function mailStatus() {
  if (!mailConfigured()) return { configured: false as const };
  const inbox = await ensureInbox();
  const now = Date.now();
  const used = (S().rate.get(MAIL_RATE_KEY) ?? []).filter((t) => now - t < 3_600_000).length;
  return {
    configured: true as const,
    inbox: { address: inbox.email, inbox_id: inbox.inbox_id, display_name: inbox.display_name },
    sending: { max_per_hour: maxPerHour(), remaining_this_hour: Math.max(0, maxPerHour() - used) },
  };
}

/* ------------------------------------------------------------------ */
/* Inbox                                                               */
/* ------------------------------------------------------------------ */

export async function listInbox(limitRaw: unknown) {
  const c = client();
  const inbox = await ensureInbox();
  const limit = clampInt(limitRaw, 1, 25, 10);
  let res;
  try {
    res = await c.inboxes.messages.list(inbox.inbox_id, { limit });
  } catch (e) {
    throw new PartnerError("AgentMail", `could not list messages: ${describeError(e)}`);
  }
  return {
    inbox: inbox.email,
    note: UNTRUSTED_NOTE,
    count: res.count,
    messages: res.messages.map((m) => ({
      message_id: m.messageId,
      thread_id: m.threadId,
      from: untrustedText(m.from, 200).text,
      to: (m.to ?? []).slice(0, 5),
      subject: untrustedText(m.subject ?? "", 200).text,
      preview: untrustedText(m.preview ?? "", 300).text,
      timestamp: new Date(m.timestamp).toISOString(),
      labels: m.labels,
      attachments: (m.attachments ?? []).length,
      direction: m.labels?.includes("sent") ? "outbound" : "inbound",
    })),
  };
}

export async function readMessage(message_id: string) {
  if (!message_id || message_id.length > 300) throw new GhostError(400, "message_id is required", "bad_request");
  const c = client();
  const inbox = await ensureInbox();
  let m;
  try {
    m = await c.inboxes.messages.get(inbox.inbox_id, message_id);
  } catch (e) {
    const status = (e as { statusCode?: number })?.statusCode;
    if (status === 404) throw new GhostError(404, "message not found", "not_found");
    throw new PartnerError("AgentMail", `could not read message: ${describeError(e)}`);
  }
  const body = untrustedText(m.extractedText ?? m.text ?? m.preview ?? "", 4000);
  return {
    note: UNTRUSTED_NOTE,
    message_id: m.messageId,
    thread_id: m.threadId,
    from: untrustedText(m.from, 200).text,
    to: m.to,
    subject: untrustedText(m.subject ?? "", 200).text,
    timestamp: new Date(m.timestamp).toISOString(),
    text: body.text,
    looks_like_instructions: body.suspicious,
    attachments: (m.attachments ?? []).map((a) => ({ filename: a.filename, content_type: a.contentType, size: a.size })),
  };
}

/* ------------------------------------------------------------------ */
/* Sending evidence reports                                            */
/* ------------------------------------------------------------------ */

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function validateRecipient(to: unknown): string {
  if (typeof to !== "string") throw new GhostError(400, "to must be a single email address (string)", "bad_request");
  const t = to.trim();
  if (!t || t.length > 254 || /[\s,;<>"\r\n]/.test(t) || !EMAIL_RE.test(t))
    throw new GhostError(400, "to must be exactly one valid email address", "bad_request");
  return t;
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtTime(isoStr: string | null | undefined): string {
  if (!isoStr) return "unknown (not reported by the source)";
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return "unknown";
  return `${d.toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

export interface MailContext {
  goal?: string;
  lease_summary?: string;
  payment_summary?: string;
  notes?: string;
}

interface EvidenceItem {
  observation: Observation;
  device: Device | null;
  attachment: { filename: string; content_type: string; bytes: number; cid: string } | null;
  attachmentB64: string | null;
}

/** May this principal read this observation? (its invoker, the device owner, or public data) */
async function canRead(principal_id: string, obs: Observation, device: Device | null): Promise<boolean> {
  if (device && (device.owner_id === principal_id || device.access_type === "public_observation")) return true;
  if (obs.invocation_id) {
    const inv = await getInvocationRaw(obs.invocation_id);
    if (inv && inv.visitor_id === principal_id) return true;
  }
  return false;
}

async function loadEvidence(principal_id: string, ids: unknown): Promise<EvidenceItem[]> {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string"))
    throw new GhostError(400, "observation_ids must be an array of strings", "bad_request");
  const uniq = [...new Set(ids as string[])];
  if (uniq.length > MAX_OBSERVATIONS) throw new GhostError(400, `at most ${MAX_OBSERVATIONS} observations per email`, "bad_request");
  const out: EvidenceItem[] = [];
  let budget = MAX_ATTACH_BYTES;
  for (const [i, oid] of uniq.entries()) {
    const obs = await getObservation(oid);
    if (!obs) throw new GhostError(404, `observation ${oid} not found`, "not_found");
    const device = await getDevice(obs.device_id).catch(() => null);
    if (!(await canRead(principal_id, obs, device))) throw new GhostError(404, `observation ${oid} not found`, "not_found");
    let attachment: EvidenceItem["attachment"] = null;
    let attachmentB64: string | null = null;
    if (obs.media_url) {
      const media = await getObservationMedia(oid);
      if (media && media.bytes.byteLength <= budget) {
        budget -= media.bytes.byteLength;
        const ext = media.media_type.includes("png") ? "png" : media.media_type.includes("jpeg") || media.media_type.includes("jpg") ? "jpg" : media.media_type.split("/")[1]?.replace(/[^a-z0-9]/g, "") || "bin";
        const cid = `obs${i}-${oid.replace(/[^a-zA-Z0-9]/g, "")}@ghost`;
        attachment = { filename: `${oid}.${ext}`, content_type: media.media_type, bytes: media.bytes.byteLength, cid };
        attachmentB64 = Buffer.from(media.bytes).toString("base64");
      }
    }
    out.push({ observation: obs, device, attachment, attachmentB64 });
  }
  return out;
}

function valueLine(o: Observation): string | null {
  if (o.value === undefined || o.value === null) return null;
  return `${o.value}${o.unit ? ` ${o.unit}` : ""}`;
}

function provenance(o: Observation, d: Device | null): string {
  const src = o.source ?? (d?.source ? { name: d.source.operator, url: d.source.url, attribution: d.source.attribution } : undefined);
  if (!src) return d ? `${d.name} (${d.owner_id})` : o.device_id;
  return [src.name, src.url, src.attribution].filter(Boolean).join(" · ");
}

function renderText(args: { text: string; items: EvidenceItem[]; ctx: MailContext; from: string }): string {
  const lines: string[] = [args.text.trim(), ""];
  if (args.ctx.goal) lines.push(`Goal: ${args.ctx.goal}`);
  if (args.items.length) {
    lines.push("", "EVIDENCE", "--------");
    args.items.forEach(({ observation: o, device: d, attachment }, i) => {
      lines.push(
        `${i + 1}. ${d?.name ?? o.device_id} — ${o.capability_id} (${o.kind})`,
        `   Captured: ${fmtTime(o.captured_at)}`,
        `   Retrieved: ${fmtTime(o.retrieved_at)}`,
        `   Source: ${provenance(o, d)}`,
      );
      const v = valueLine(o);
      if (v) lines.push(`   Value: ${v}`);
      if (o.note) lines.push(`   Note: ${o.note}`);
      lines.push(`   Observation id: ${o.observation_id}${attachment ? ` (attached as ${attachment.filename})` : ""}`);
    });
  }
  if (args.ctx.lease_summary || args.ctx.payment_summary) {
    lines.push("", "ACCESS");
    if (args.ctx.lease_summary) lines.push(`Lease: ${args.ctx.lease_summary}`);
    if (args.ctx.payment_summary) lines.push(`Payment: ${args.ctx.payment_summary}`);
  }
  if (args.ctx.notes) lines.push("", args.ctx.notes);
  lines.push("", "—", `Sent by Polty, a GHOST personal agent (${args.from}). Reply to this address to reach Polty.`);
  return lines.join("\n");
}

function renderHtml(args: { subject: string; text: string; items: EvidenceItem[]; ctx: MailContext; from: string }): string {
  const C = { ink: "#0a0b0e", ink2: "#111318", ink3: "#181b22", line: "#2a2d33", ivory: "#f4efe4", dim: "#c9c4b8", mute: "#8a877f", mint: "#5df2b5", mintDeep: "#1f8f68" };
  const pStyle = `margin:0 0 12px;font-size:14px;line-height:1.55;color:${C.dim}`;
  const para = esc(args.text.trim()).replace(/\n{2,}/g, `</p><p style="${pStyle}">`).replace(/\n/g, "<br>");
  const row = (k: string, v: string) =>
    `<tr><td style="padding:3px 12px 3px 0;color:${C.mute};font-size:12px;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:3px 0;color:${C.dim};font-size:13px;word-break:break-word">${v}</td></tr>`;
  const cards = args.items
    .map(({ observation: o, device: d, attachment }, i) => {
      const src = o.source?.url ?? d?.source?.url;
      const img = attachment && attachment.content_type.startsWith("image/")
        ? `<img src="cid:${esc(attachment.cid)}" alt="${esc(d?.name ?? "observation")}" width="536" style="display:block;width:100%;max-width:536px;height:auto;border-radius:10px;border:1px solid ${C.line};margin:0 0 12px">`
        : "";
      const v = valueLine(o);
      return `
      <tr><td style="padding:0 0 16px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.ink3};border:1px solid ${C.line};border-radius:14px">
          <tr><td style="padding:16px">
            <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${C.mint};margin:0 0 6px">Evidence ${i + 1} · ${esc(o.kind)}</div>
            <div style="font-size:16px;font-weight:600;color:${C.ivory};margin:0 0 12px">${esc(d?.name ?? o.device_id)}</div>
            ${img}
            ${v ? `<div style="font-size:22px;font-weight:600;color:${C.mint};margin:0 0 10px">${esc(v)}</div>` : ""}
            <table role="presentation" cellpadding="0" cellspacing="0">
              ${row("Captured", esc(fmtTime(o.captured_at)))}
              ${row("Retrieved", esc(fmtTime(o.retrieved_at)))}
              ${row("Capability", esc(o.capability_id))}
              ${row("Source", src ? `<a href="${esc(src)}" style="color:${C.mint};text-decoration:none">${esc(provenance(o, d))}</a>` : esc(provenance(o, d)))}
              ${o.note ? row("Note", esc(o.note)) : ""}
              ${row("Observation", `<span style="font-family:ui-monospace,Menlo,monospace;font-size:12px">${esc(o.observation_id)}</span>`)}
            </table>
          </td></tr>
        </table>
      </td></tr>`;
    })
    .join("");
  const access =
    args.ctx.lease_summary || args.ctx.payment_summary
      ? `<tr><td style="padding:0 0 16px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:14px">
            <tr><td style="padding:14px 16px">
              <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${C.mute};margin:0 0 8px">Access</div>
              <table role="presentation" cellpadding="0" cellspacing="0">
                ${args.ctx.lease_summary ? row("Lease", esc(args.ctx.lease_summary)) : ""}
                ${args.ctx.payment_summary ? row("Payment", esc(args.ctx.payment_summary)) : ""}
              </table>
            </td></tr>
          </table>
        </td></tr>`
      : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${esc(args.subject)}</title></head>
<body style="margin:0;padding:0;background:${C.ink};color:${C.ivory};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.ink}"><tr><td align="center" style="padding:28px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${C.ink2};border:1px solid ${C.line};border-radius:18px">
    <tr><td style="padding:22px 24px 8px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="width:34px;height:34px;border-radius:17px;background:${C.ivory};text-align:center;vertical-align:middle;font-size:18px;line-height:34px;color:${C.ink}">&#128123;</td>
        <td style="padding-left:12px"><div style="font-size:15px;font-weight:700;letter-spacing:.06em;color:${C.ivory}">GHOST</div><div style="font-size:12px;color:${C.mute}">Polty's evidence report</div></td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:16px 24px 4px">
      <div style="font-size:20px;font-weight:600;color:${C.ivory};margin:0 0 12px">${esc(args.subject)}</div>
      ${args.ctx.goal ? `<div style="font-size:13px;color:${C.mint};margin:0 0 12px">Goal · ${esc(args.ctx.goal)}</div>` : ""}
      <p style="${pStyle}">${para}</p>
    </td></tr>
    <tr><td style="padding:8px 24px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${cards}${access}</table></td></tr>
    ${args.ctx.notes ? `<tr><td style="padding:0 24px 12px;font-size:13px;color:${C.dim}">${esc(args.ctx.notes)}</td></tr>` : ""}
    <tr><td style="padding:12px 24px 22px;border-top:1px solid ${C.line};font-size:12px;color:${C.mute};line-height:1.5">
      Sent by Polty, a GHOST personal agent · reply to <span style="color:${C.ivory}">${esc(args.from)}</span> to reach Polty.<br>
      Capture times come from the source; "unknown" means the source did not report one.
    </td></tr>
  </table>
</td></tr></table></body></html>`;
}

export interface BuiltReport {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments: { filename: string; contentType: string; contentDisposition: "inline"; contentId: string; content: string }[];
  observations: { observation_id: string; device: string; attached: boolean; reason?: string }[];
}

/** Validate the request, load the evidence the caller may read, and render the email (no sending). */
export async function buildReport(
  principal_id: string,
  body: { to?: unknown; subject?: unknown; text?: unknown; observation_ids?: unknown; context?: unknown },
  from: string,
): Promise<BuiltReport> {
  const to = validateRecipient(body.to);
  const subject = typeof body.subject === "string" ? body.subject.replace(/[\r\n]+/g, " ").trim().slice(0, 200) : "";
  if (!subject) throw new GhostError(400, "subject is required", "bad_request");
  const text = typeof body.text === "string" ? body.text.slice(0, 10_000) : "";
  if (!text.trim()) throw new GhostError(400, "text is required", "bad_request");
  const rawCtx = body.context && typeof body.context === "object" ? (body.context as Record<string, unknown>) : {};
  const ctx: MailContext = {};
  for (const k of ["goal", "lease_summary", "payment_summary", "notes"] as const) {
    if (typeof rawCtx[k] === "string" && (rawCtx[k] as string).trim()) ctx[k] = (rawCtx[k] as string).slice(0, 1000);
  }
  const items = await loadEvidence(principal_id, body.observation_ids);
  return {
    to,
    subject,
    text: renderText({ text, items, ctx, from }),
    html: renderHtml({ subject, text, items, ctx, from }),
    attachments: items
      .filter((it) => it.attachment && it.attachmentB64)
      .map((it) => ({
        filename: it.attachment!.filename,
        contentType: it.attachment!.content_type,
        contentDisposition: "inline" as const,
        contentId: it.attachment!.cid,
        content: it.attachmentB64!,
      })),
    observations: items.map((it) => ({
      observation_id: it.observation.observation_id,
      device: it.device?.name ?? it.observation.device_id,
      attached: !!it.attachment,
      ...(it.attachment ? {} : { reason: it.observation.media_url ? "media too large for email" : "no media (details in body)" }),
    })),
  };
}

const MAIL_RATE_KEY = "partners:mail:global";

export async function sendReport(
  principal_id: string,
  body: { to?: unknown; subject?: unknown; text?: unknown; observation_ids?: unknown; context?: unknown },
) {
  client(); // 503 early if not configured
  const inbox = await ensureInbox();
  const report = await buildReport(principal_id, body, inbox.email);
  // Outward-facing action: global sliding-window limit (default 10 per hour).
  if (!await rateLimit(MAIL_RATE_KEY, maxPerHour(), 3_600_000))
    throw new GhostError(429, `mail rate limit reached (${maxPerHour()} per hour)`, "rate_limited");
  let res;
  try {
    res = await client().inboxes.messages.send(inbox.inbox_id, {
      to: report.to,
      subject: report.subject,
      text: report.text,
      html: report.html,
      attachments: report.attachments.length ? report.attachments : undefined,
      labels: ["ghost-evidence"],
    });
  } catch (e) {
    throw new PartnerError("AgentMail", `send failed: ${describeError(e)}`);
  }
  return {
    sent: true,
    message_id: res.messageId,
    thread_id: res.threadId,
    from: inbox.email,
    to: report.to,
    subject: report.subject,
    observations: report.observations,
  };
}
