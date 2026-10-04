import type { InternalAdapter } from "../types";
import { calendarCreate, calendarEvents, contactsSearch, driveSearch, gmailRead, gmailSearch } from "../../google/api";
import { getTokens, googleConfigured, GoogleNotConnected } from "../../google/oauth";
import { defineService, intArg, ok, reject, str, ui } from "./common";

/**
 * Google Workspace (Gmail, Calendar, Drive, Contacts) via per-principal OAuth.
 * Every call uses the INVOKING principal's tokens (ctx.visitor_id) — each visitor sees only their own Google data.
 */

const NOT_CONNECTED = "Google not connected — open Connectors and connect Google Workspace";

async function requireConnected(pid: string): Promise<string | null> {
  if (!googleConfigured()) return "Google Workspace is not set up on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing)";
  const row = await getTokens(pid);
  return row ? null : NOT_CONNECTED;
}

const fmtWhen = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") + "Z" : "");
const shortFrom = (f: string) => f.replace(/\s*<[^>]+>\s*$/, "").replace(/^"|"$/g, "") || f;

const base = defineService({
  id: "google",
  name: "Google Workspace",
  vendor: "Google",
  icon: "mail",
  source: { operator: "Google (user's own account via OAuth)", url: "https://workspace.google.com" },
  note: "The invoking user's own Gmail, Calendar, Drive and Contacts. Requires connecting Google Workspace in Connectors.",
  caps: [
    {
      capability_id: "gmail.search",
      semantic_type: "gmail.search",
      title: "Search my email",
      description: "Recent inbox emails, or emails matching a Gmail search query (e.g. 'from:alice', 'is:unread', 'subject:invoice newer_than:7d'). Returns from, subject, snippet, date, id.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string", description: "Gmail search syntax; omit for latest inbox" }, max: { type: "integer", minimum: 1, maximum: 20, default: 8 } },
        additionalProperties: false,
      },
      estimated_ms: 1500,
      async run(args, ctx) {
        const why = await requireConnected(ctx.visitor_id);
        if (why) return { state: "failed", error: why };
        const max = intArg(args.max, 1, 20, 8);
        if (max === null) return reject("max must be an integer 1-20");
        const query = str(args.query, 300);
        const mails = await gmailSearch(ctx.visitor_id, query, max, ctx.signal);
        return ok({
          kind: "text",
          value: mails.length ? mails.map((m) => `• ${fmtWhen(m.date)} ${shortFrom(m.from)} — ${m.subject}${m.unread ? " (unread)" : ""} [id ${m.id}]`).join("\n") : "No matching emails.",
          captured_at: null,
          source: { name: "Gmail" },
          note: "Times are UTC. Use gmail.read with an id for the full message.",
          data: {
            query,
            messages: mails,
            ui: ui(
              "list",
              { items: mails.map((m) => ({ title: `${m.unread ? "● " : ""}${m.subject}`, subtitle: `${shortFrom(m.from)} · ${m.date ? new Date(m.date).toLocaleString() : ""}\n${m.snippet}`, url: m.url })) },
              query ? `Mail: ${query}` : "Inbox",
            ),
          },
        });
      },
    },
    {
      capability_id: "gmail.read",
      semantic_type: "gmail.read",
      title: "Read an email",
      description: "Full text of one email by id (from gmail.search).",
      input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
      async run(args, ctx) {
        const why = await requireConnected(ctx.visitor_id);
        if (why) return { state: "failed", error: why };
        const id = str(args.id, 100);
        if (!id) return reject("id is required");
        const m = await gmailRead(ctx.visitor_id, id, ctx.signal);
        return ok({
          kind: "text",
          value: `From: ${m.from}\nTo: ${m.to}\nSubject: ${m.subject}\nDate: ${m.date}\n\n${m.body}`,
          captured_at: m.date,
          source: { name: "Gmail" },
          data: { message: m, ui: ui("list", { items: [{ title: m.subject, subtitle: `${shortFrom(m.from)}\n\n${m.body.slice(0, 1500)}`, url: m.url }] }, "Email") },
        });
      },
    },
    {
      capability_id: "gcal.events",
      semantic_type: "gcal.events",
      title: "My Google Calendar",
      description: "Upcoming events from the user's primary Google Calendar for the next 1-14 days (title, start, end, location).",
      input_schema: { type: "object", properties: { days: { type: "integer", minimum: 1, maximum: 14, default: 3 } }, additionalProperties: false },
      async run(args, ctx) {
        const why = await requireConnected(ctx.visitor_id);
        if (why) return { state: "failed", error: why };
        const days = intArg(args.days, 1, 14, 3);
        if (days === null) return reject("days must be an integer 1-14");
        const events = await calendarEvents(ctx.visitor_id, days, ctx.signal);
        return ok({
          kind: "text",
          value: events.length ? events.slice(0, 10).map((e) => `• ${e.start} ${e.title}${e.location ? ` @ ${e.location}` : ""}`).join("\n") : `No events in the next ${days} day(s).`,
          captured_at: null,
          source: { name: "Google Calendar" },
          note: "Times are ISO UTC; convert to the user's timezone when speaking.",
          data: { days, events, ui: ui("agenda", { days, events }, "Google Calendar") },
        });
      },
    },
    {
      capability_id: "gcal.create",
      semantic_type: "gcal.create",
      title: "Create a calendar event",
      description: "Create an event on the user's primary Google Calendar. start/end are ISO 8601 date-times with timezone offset.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          start: { type: "string", description: "ISO 8601, e.g. 2026-10-05T15:00:00-07:00" },
          end: { type: "string", description: "ISO 8601" },
          description: { type: "string" },
        },
        required: ["title", "start", "end"],
        additionalProperties: false,
      },
      async run(args, ctx) {
        const why = await requireConnected(ctx.visitor_id);
        if (why) return { state: "failed", error: why };
        const title = str(args.title, 200);
        const start = str(args.start, 40);
        const end = str(args.end, 40);
        if (!title || !start || !end) return reject("title, start and end are required");
        if (Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) return reject("start/end must be ISO 8601 date-times");
        if (Date.parse(end) <= Date.parse(start)) return reject("end must be after start");
        const ev = await calendarCreate(ctx.visitor_id, { title, start, end, description: str(args.description, 2000) }, ctx.signal);
        return ok({
          kind: "text",
          value: `Created "${ev.title}" at ${ev.start}.`,
          captured_at: new Date().toISOString(),
          source: { name: "Google Calendar" },
          data: { event: ev, ui: ui("agenda", { days: 1, events: [ev] }, "Event created") },
        });
      },
    },
    {
      capability_id: "drive.search",
      semantic_type: "drive.search",
      title: "Search my Drive",
      description: "Find files in the user's Google Drive by name or content.",
      input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
      async run(args, ctx) {
        const why = await requireConnected(ctx.visitor_id);
        if (why) return { state: "failed", error: why };
        const query = str(args.query, 200);
        if (!query) return reject("query is required");
        const files = await driveSearch(ctx.visitor_id, query, ctx.signal);
        const kind = (m: string) => m.split(".").pop()?.replace("application/", "").replace("vnd.google-apps.", "") ?? m;
        return ok({
          kind: "text",
          value: files.length ? files.map((f) => `• ${f.name} (${kind(f.mimeType)}, modified ${f.modifiedTime ?? "?"})`).join("\n") : `No Drive files match "${query}".`,
          captured_at: null,
          source: { name: "Google Drive" },
          data: {
            query,
            files,
            ui: ui("list", { items: files.map((f) => ({ title: f.name, subtitle: `${kind(f.mimeType)} · ${f.owner ?? ""} · ${f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString() : ""}`, url: f.webViewLink })) }, `Drive: ${query}`),
          },
        });
      },
    },
    {
      capability_id: "contacts.search",
      semantic_type: "contacts.search",
      title: "Search my contacts",
      description: "Look up people in the user's Google Contacts (name, email, phone, organization).",
      input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
      async run(args, ctx) {
        const why = await requireConnected(ctx.visitor_id);
        if (why) return { state: "failed", error: why };
        const query = str(args.query, 100);
        if (!query) return reject("query is required");
        const people = await contactsSearch(ctx.visitor_id, query, ctx.signal);
        return ok({
          kind: "text",
          value: people.length ? people.map((p) => `• ${p.name}${p.emails[0] ? ` <${p.emails[0]}>` : ""}${p.phones[0] ? ` ${p.phones[0]}` : ""}`).join("\n") : `No contacts match "${query}".`,
          captured_at: null,
          source: { name: "Google Contacts" },
          data: {
            query,
            contacts: people,
            ui: ui("list", { items: people.map((p) => ({ title: p.name, subtitle: [p.organization, ...p.emails, ...p.phones].filter(Boolean).join(" · "), image: p.photo })) }, "Contacts"),
          },
        });
      },
    },
  ],
});

/** Same adapter, with gcal.create published as an "act" capability and not-connected errors kept verbatim. */
export const googleService: InternalAdapter = {
  ...base,
  async discover(ctx) {
    const found = (await base.discover?.(ctx)) ?? [];
    for (const d of found) {
      d.manifest.capabilities = d.manifest.capabilities.map((c) =>
        c.capability_id === "gcal.create" ? { ...c, kind: "act", verification: "reported_state", exclusive: false } : c,
      );
    }
    return found;
  },
  async invoke(device, capability_id, args, ctx) {
    try {
      return await base.invoke(device, capability_id, args, ctx);
    } catch (e) {
      if (e instanceof GoogleNotConnected) return { state: "failed", error: NOT_CONNECTED };
      throw e;
    }
  },
};
