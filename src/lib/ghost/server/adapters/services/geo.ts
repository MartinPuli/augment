import { fetchCached } from "./common";

export interface Place {
  name: string;
  lat: number;
  lon: number;
  country: string | null;
  admin1: string | null;
  timezone: string | null;
  label: string;
}

/** Open-Meteo geocoding (keyless). Returns best matches; empty when nothing found. */
export async function geocode(query: string, count = 1, signal?: AbortSignal): Promise<Place[]> {
  // Open-Meteo matches on the place name only; "Paris, France" -> search "Paris", prefer country match.
  const [head, ...rest] = query.split(",").map((s) => s.trim()).filter(Boolean);
  const qs = new URLSearchParams({ name: head ?? query, count: String(Math.max(count, rest.length ? 10 : count)), language: "en", format: "json" });
  const { body } = await fetchCached<{ results?: Record<string, unknown>[] }>(`https://geocoding-api.open-meteo.com/v1/search?${qs}`, { signal, ttl: 3600_000 });
  let rows = Array.isArray(body.results) ? body.results : [];
  if (rest.length) {
    const hint = rest.join(" ").toLowerCase();
    const pref = rows.filter((r) => [r.country, r.country_code, r.admin1].some((v) => typeof v === "string" && hint.includes(v.toLowerCase())));
    if (pref.length) rows = pref;
  }
  return rows.slice(0, count).map((r) => {
    const name = String(r.name ?? head);
    const admin1 = typeof r.admin1 === "string" ? r.admin1 : null;
    const country = typeof r.country === "string" ? r.country : null;
    return {
      name,
      lat: Number(r.latitude),
      lon: Number(r.longitude),
      country,
      admin1,
      timezone: typeof r.timezone === "string" ? r.timezone : null,
      label: [name, admin1, country].filter(Boolean).join(", "),
    };
  });
}

export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
