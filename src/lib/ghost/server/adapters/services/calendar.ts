import ical, { type VEvent } from "node-ical";
import { env } from "../../partners/common";
import { defineService, fetchCached, intArg, ok, reject, ui } from "./common";

/**
 * Personal agenda from a secret iCal URL (Google Calendar → Settings → "Secret address in iCal format").
 * Env: GOOGLE_CALENDAR_ICS_URL. RRULE / EXDATE / overrides are expanded by node-ical.
 */

const pv = (v: unknown): string | null => {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "val" in v) return String((v as { val: unknown }).val);
  return null;
};

function icsUrl(): string | undefined {
  const u = env("GOOGLE_CALENDAR_ICS_URL");
  return u ? u.replace(/^webcal:\/\//i, "https://") : undefined;
}

export const calendarService = defineService({
  id: "calendar",
  name: "My calendar (iCal)",
  vendor: "Google Calendar",
  icon: "calendar",
  source: { operator: "Owner's calendar (private iCal feed)", url: "https://calendar.google.com" },
  note: "The owner's private calendar feed. Read-only.",
  unavailable: () => (icsUrl() ? null : "set GOOGLE_CALENDAR_ICS_URL to the calendar's secret iCal address"),
  caps: [
    {
      capability_id: "calendar.agenda",
      title: "My upcoming agenda",
      description: "Upcoming events from the user's own calendar for the next 1-14 days (title, start, end, location). Recurring events are expanded.",
      input_schema: {
        type: "object",
        properties: { days: { type: "integer", minimum: 1, maximum: 14, default: 3 } },
        additionalProperties: false,
      },
      async run(args, ctx) {
        const days = intArg(args.days, 1, 14, 3);
        if (days === null) return reject("days must be an integer 1-14");
        const url = icsUrl()!;
        const { body: text, cached } = await fetchCached<string>(url, { signal: ctx.signal, as: "text", key: "calendar-ics" });
        const parsed = ical.sync.parseICS(text);
        const from = new Date();
        const to = new Date(from.getTime() + days * 86_400_000);
        const events: { title: string; start: string; end: string | null; all_day: boolean; location: string | null; url: string | null }[] = [];
        for (const comp of Object.values(parsed)) {
          if (!comp || comp.type !== "VEVENT") continue;
          const ev = comp as VEvent;
          if (ev.recurrenceid) continue; // overrides are applied through the base event
          let instances;
          try {
            instances = ical.expandRecurringEvent(ev, { from, to, expandOngoing: true });
          } catch {
            continue;
          }
          for (const inst of instances) {
            const e = inst.event ?? ev;
            events.push({
              title: pv(inst.summary) ?? pv(e.summary) ?? "(no title)",
              start: new Date(inst.start).toISOString(),
              end: inst.end ? new Date(inst.end).toISOString() : null,
              all_day: inst.isFullDay,
              location: pv(e.location) ?? null,
              url: typeof e.url === "string" ? e.url : null,
            });
          }
        }
        events.sort((a, b) => a.start.localeCompare(b.start));
        const list = events.slice(0, 50);
        return ok({
          kind: "text",
          value: list.length ? list.slice(0, 8).map((e) => `• ${e.start} ${e.title}${e.location ? ` @ ${e.location}` : ""}`).join("\n") : `No events in the next ${days} day(s).`,
          captured_at: null,
          source: { name: "Owner's calendar (iCal)" },
          note: "Times are ISO UTC; convert to the user's timezone when speaking.",
          data: { days, from: from.toISOString(), to: to.toISOString(), events: list, total: events.length, cached, ui: ui("agenda", { days, events: list }, "Agenda") },
        });
      },
    },
  ],
});
