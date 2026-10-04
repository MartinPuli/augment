import { accessToken } from "./oauth";

/** Minimal Google REST helpers (Gmail, Calendar, Drive, People) using the principal's OAuth tokens. */

export async function gfetch<T = unknown>(
  principal_id: string,
  url: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const call = async (token: string) => {
    const signals = [AbortSignal.timeout(10_000)];
    if (init.signal) signals.push(init.signal);
    return fetch(url, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.any(signals),
    });
  };
  let res = await call(await accessToken(principal_id));
  if (res.status === 401) res = await call(await accessToken(principal_id, true));
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(j?.error?.message ?? `HTTP ${res.status} from ${new URL(url).hostname}`);
  }
  return (await res.json()) as T;
}

/* ---------------- Gmail ---------------- */

export interface MailSummary {
  id: string;
  thread_id: string;
  from: string;
  subject: string;
  snippet: string;
  date: string | null;
  unread: boolean;
  url: string;
}

interface GmailHeader { name: string; value: string }
interface GmailPart { mimeType?: string; body?: { data?: string }; parts?: GmailPart[]; headers?: GmailHeader[] }
interface GmailMsg { id: string; threadId: string; snippet?: string; labelIds?: string[]; internalDate?: string; payload?: GmailPart }

const hdr = (m: GmailMsg, name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
const decodeHtml = (s: string) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function summarize(m: GmailMsg): MailSummary {
  return {
    id: m.id,
    thread_id: m.threadId,
    from: hdr(m, "From"),
    subject: hdr(m, "Subject") || "(no subject)",
    snippet: decodeHtml(m.snippet ?? ""),
    date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
    unread: !!m.labelIds?.includes("UNREAD"),
    url: `https://mail.google.com/mail/u/0/#all/${m.threadId}`,
  };
}

const GM = "https://gmail.googleapis.com/gmail/v1/users/me";

export async function gmailSearch(pid: string, query: string | null, max: number, signal?: AbortSignal): Promise<MailSummary[]> {
  const p = new URLSearchParams({ maxResults: String(max) });
  if (query) p.set("q", query);
  else p.set("labelIds", "INBOX");
  const list = await gfetch<{ messages?: { id: string }[] }>(pid, `${GM}/messages?${p}`, { signal });
  const ids = (list.messages ?? []).map((m) => m.id);
  const msgs = await Promise.all(
    ids.map((id) =>
      gfetch<GmailMsg>(pid, `${GM}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { signal }),
    ),
  );
  return msgs.map(summarize);
}

function b64(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function findBody(p: GmailPart | undefined, mime: string): string | null {
  if (!p) return null;
  if (p.mimeType === mime && p.body?.data) return b64(p.body.data);
  for (const c of p.parts ?? []) {
    const r = findBody(c, mime);
    if (r) return r;
  }
  return null;
}

export async function gmailRead(pid: string, id: string, signal?: AbortSignal) {
  const m = await gfetch<GmailMsg>(pid, `${GM}/messages/${encodeURIComponent(id)}?format=full`, { signal });
  let body = findBody(m.payload, "text/plain");
  if (!body) {
    const html = findBody(m.payload, "text/html");
    body = html ? decodeHtml(html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ")) : m.snippet ?? "";
  }
  body = body.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim().slice(0, 6000);
  return { ...summarize(m), to: hdr(m, "To"), cc: hdr(m, "Cc"), body };
}

/* ---------------- Calendar ---------------- */

interface GEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

export interface AgendaEvent { id: string; title: string; start: string; end: string | null; all_day: boolean; location: string | null; url: string | null }

function toAgenda(e: GEvent): AgendaEvent {
  const allDay = !e.start?.dateTime;
  return {
    id: e.id,
    title: e.summary ?? "(no title)",
    start: new Date(e.start?.dateTime ?? `${e.start?.date}T00:00:00`).toISOString(),
    end: e.end?.dateTime ?? e.end?.date ? new Date(e.end?.dateTime ?? `${e.end?.date}T00:00:00`).toISOString() : null,
    all_day: allDay,
    location: e.location ?? null,
    url: e.htmlLink ?? null,
  };
}

const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export async function calendarEvents(pid: string, days: number, signal?: AbortSignal): Promise<AgendaEvent[]> {
  const now = new Date();
  const p = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: new Date(now.getTime() + days * 86_400_000).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50",
  });
  const r = await gfetch<{ items?: GEvent[] }>(pid, `${CAL}?${p}`, { signal });
  return (r.items ?? []).map(toAgenda);
}

export async function calendarCreate(
  pid: string,
  ev: { title: string; start: string; end: string; description?: string | null },
  signal?: AbortSignal,
): Promise<AgendaEvent> {
  const r = await gfetch<GEvent>(pid, CAL, {
    method: "POST",
    signal,
    body: { summary: ev.title, description: ev.description ?? undefined, start: { dateTime: ev.start }, end: { dateTime: ev.end } },
  });
  return toAgenda(r);
}

/* ---------------- Drive ---------------- */

export interface DriveFile { id: string; name: string; mimeType: string; modifiedTime: string | null; webViewLink: string | null; iconLink: string | null; owner: string | null }

export async function driveSearch(pid: string, query: string, signal?: AbortSignal): Promise<DriveFile[]> {
  const esc = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const p = new URLSearchParams({
    q: `(name contains '${esc}' or fullText contains '${esc}') and trashed = false`,
    pageSize: "15",
    orderBy: "modifiedTime desc",
    fields: "files(id,name,mimeType,modifiedTime,webViewLink,iconLink,owners(displayName))",
  });
  const r = await gfetch<{ files?: (Omit<DriveFile, "owner"> & { owners?: { displayName?: string }[] })[] }>(
    pid,
    `https://www.googleapis.com/drive/v3/files?${p}`,
    { signal },
  );
  return (r.files ?? []).map((f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: f.modifiedTime ?? null,
    webViewLink: f.webViewLink ?? null,
    iconLink: f.iconLink ?? null,
    owner: f.owners?.[0]?.displayName ?? null,
  }));
}

/* ---------------- Contacts (People API) ---------------- */

export interface Contact { name: string; emails: string[]; phones: string[]; organization: string | null; photo: string | null }

interface Person {
  names?: { displayName?: string }[];
  emailAddresses?: { value?: string }[];
  phoneNumbers?: { value?: string }[];
  organizations?: { name?: string; title?: string }[];
  photos?: { url?: string }[];
}

export async function contactsSearch(pid: string, query: string, signal?: AbortSignal): Promise<Contact[]> {
  const fields = "names,emailAddresses,phoneNumbers,organizations,photos";
  // People API asks for a warm-up empty query before the cache serves searches.
  await gfetch(pid, `https://people.googleapis.com/v1/people:searchContacts?query=&readMask=${fields}`, { signal }).catch(() => null);
  const p = new URLSearchParams({ query, readMask: fields, pageSize: "15" });
  const r = await gfetch<{ results?: { person?: Person }[] }>(pid, `https://people.googleapis.com/v1/people:searchContacts?${p}`, { signal });
  return (r.results ?? []).map(({ person: x = {} }) => ({
    name: x.names?.[0]?.displayName ?? "(no name)",
    emails: (x.emailAddresses ?? []).map((e) => e.value ?? "").filter(Boolean),
    phones: (x.phoneNumbers ?? []).map((e) => e.value ?? "").filter(Boolean),
    organization: x.organizations?.[0] ? [x.organizations[0].title, x.organizations[0].name].filter(Boolean).join(", ") || null : null,
    photo: x.photos?.[0]?.url ?? null,
  }));
}
