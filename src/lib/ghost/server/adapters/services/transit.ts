/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed third-party JSON */
import { defineService, fetchCached, ok, reject, str, ui } from "./common";

/** BART real-time departures (public demo key published by BART: https://www.bart.gov/schedules/developers/api). */

const KEY = "MW9S-E7SL-26DU-VV8V";
const API = "https://api.bart.gov/api";

interface Station {
  name: string;
  abbr: string;
  lat: number;
  lon: number;
}

async function stations(signal: AbortSignal): Promise<Station[]> {
  const { body } = await fetchCached<any>(`${API}/stn.aspx?cmd=stns&key=${KEY}&json=y`, { signal, ttl: 24 * 3600_000 });
  return (body?.root?.stations?.station ?? []).map((s: any) => ({ name: s.name, abbr: s.abbr, lat: Number(s.gtfs_latitude), lon: Number(s.gtfs_longitude) }));
}

const norm = (s: string) => s.toLowerCase().replace(/street/g, "st").replace(/[^a-z0-9]/g, "");

function match(all: Station[], q: string): Station | null {
  const up = q.trim().toUpperCase();
  const byAbbr = all.find((s) => s.abbr === up);
  if (byAbbr) return byAbbr;
  const nq = norm(q.replace(/\bbart\b|\bstation\b/gi, ""));
  if (!nq) return null;
  return all.find((s) => norm(s.name) === nq) ?? all.find((s) => norm(s.name).startsWith(nq)) ?? all.find((s) => norm(s.name).includes(nq)) ?? null;
}

/** "10/04/2026" + "03:22:03 PM PDT" -> ISO */
function bartTime(date: unknown, time: unknown): string | null {
  const d = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(date ?? ""));
  const t = /^(\d{1,2}):(\d{2}):(\d{2}) (AM|PM) (PDT|PST)$/.exec(String(time ?? ""));
  if (!d || !t) return null;
  let h = Number(t[1]) % 12;
  if (t[4] === "PM") h += 12;
  const off = t[5] === "PDT" ? 7 : 8;
  return new Date(Date.UTC(+d[3], +d[1] - 1, +d[2], h + off, +t[2], +t[3])).toISOString();
}

export const transitService = defineService({
  id: "transit",
  name: "BART real-time departures",
  vendor: "BART",
  icon: "train-front",
  source: { operator: "Bay Area Rapid Transit", url: "https://www.bart.gov/schedules/developers/api", attribution: "BART real-time data", conditions_url: "https://www.bart.gov/schedules/developers/developer-license-agreement" },
  caps: [
    {
      capability_id: "transit.departures",
      title: "Next BART trains from a station",
      description: "Real-time BART departures (minutes until departure, destination, platform, line color) from a Bay Area BART station, by name ('Embarcadero', 'Powell') or abbreviation ('EMBR').",
      input_schema: {
        type: "object",
        properties: { station: { type: "string", description: "BART station name or 4-letter abbreviation." } },
        required: ["station"],
        additionalProperties: false,
      },
      async run(args, ctx) {
        const q = str(args.station, 80);
        if (!q) return reject("station is required");
        const all = await stations(ctx.signal);
        const st = match(all, q);
        if (!st) return { state: "rejected", error: `no BART station matches "${q}". Known: ${all.map((s) => `${s.name} (${s.abbr})`).join(", ")}` };
        const url = `${API}/etd.aspx?cmd=etd&orig=${st.abbr}&key=${KEY}&json=y`;
        const { body, cached } = await fetchCached<any>(url, { signal: ctx.signal, ttl: 30_000 });
        const root = body?.root ?? {};
        const etds = root.station?.[0]?.etd ?? [];
        const departures = etds
          .flatMap((e: any) =>
            (e.estimate ?? []).map((x: any) => ({
              destination: e.destination as string,
              minutes: x.minutes === "Leaving" ? 0 : Number(x.minutes),
              leaving: x.minutes === "Leaving",
              platform: x.platform ?? null,
              direction: x.direction ?? null,
              cars: Number(x.length) || null,
              color: x.color ?? null,
              hexcolor: x.hexcolor ?? null,
              delay_s: Number(x.delay) || 0,
              cancelled: x.cancelflag === "1",
            })),
          )
          .filter((d: { minutes: number }) => Number.isFinite(d.minutes))
          .sort((a: { minutes: number }, b: { minutes: number }) => a.minutes - b.minutes);
        const captured_at = bartTime(root.date, root.time);
        const message = typeof root.message === "string" ? root.message : root.message?.warning ?? null;
        return ok({
          kind: "text",
          value: departures.length
            ? departures.slice(0, 6).map((d: any) => `${d.leaving ? "Leaving" : `${d.minutes} min`} → ${d.destination} (platform ${d.platform})`).join("\n")
            : `No departures currently listed at ${st.name}.`,
          captured_at,
          source: { name: "BART API", url: `https://www.bart.gov/stations/${st.abbr.toLowerCase()}` },
          data: {
            station: st,
            departures,
            message,
            cached,
            ui: ui("departures", { station: st.name, abbr: st.abbr, departures, updated_at: captured_at }, `BART · ${st.name}`),
          },
        });
      },
    },
  ],
});
