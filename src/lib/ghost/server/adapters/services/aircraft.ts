import { defineService, fetchCached, numArg, ok, reject, ui } from "./common";
import { haversineKm } from "./geo";

/** OpenSky Network anonymous state vectors. https://openskynetwork.github.io/opensky-api/rest.html */

export const aircraftService = defineService({
  id: "aircraft",
  name: "Aircraft nearby · OpenSky",
  vendor: "OpenSky Network",
  icon: "plane",
  source: { operator: "The OpenSky Network", url: "https://opensky-network.org", attribution: "The OpenSky Network, https://opensky-network.org", conditions_url: "https://opensky-network.org/about/terms-of-use" },
  note: "Anonymous OpenSky API (non-commercial; rate-limited, ~10 s resolution).",
  caps: [
    {
      capability_id: "aircraft.nearby",
      title: "Aircraft flying near a point",
      description: "Live ADS-B aircraft within radius_km (default 25, max 150) of lat/lon: callsign, altitude, speed, heading, origin country. Use place.geocode first if you only have a place name.",
      input_schema: {
        type: "object",
        properties: {
          lat: { type: "number", minimum: -90, maximum: 90 },
          lon: { type: "number", minimum: -180, maximum: 180 },
          radius_km: { type: "number", minimum: 1, maximum: 150, default: 25 },
        },
        required: ["lat", "lon"],
        additionalProperties: false,
      },
      estimated_ms: 2500,
      async run(args, ctx) {
        const lat = numArg(args.lat, -90, 90, null);
        const lon = numArg(args.lon, -180, 180, null);
        const r = numArg(args.radius_km, 1, 150, 25);
        if (lat === null || lon === null) return reject("lat and lon are required numbers");
        if (r === null) return reject("radius_km must be 1-150");
        const dLat = r / 111;
        const dLon = r / (111 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
        const f = (x: number) => x.toFixed(3);
        const qs = `lamin=${f(lat - dLat)}&lamax=${f(lat + dLat)}&lomin=${f(lon - dLon)}&lomax=${f(lon + dLon)}`;
        const url = `https://opensky-network.org/api/states/all?${qs}`;
        const { body, cached } = await fetchCached<{ time?: number; states?: unknown[][] | null }>(url, { signal: ctx.signal });
        const aircraft = (body.states ?? [])
          .map((s) => ({
            icao24: String(s[0]),
            callsign: typeof s[1] === "string" ? s[1].trim() || null : null,
            origin_country: (s[2] as string) ?? null,
            last_contact: typeof s[4] === "number" ? new Date(s[4] * 1000).toISOString() : null,
            lon: s[5] as number | null,
            lat: s[6] as number | null,
            altitude_m: (s[13] as number | null) ?? (s[7] as number | null),
            on_ground: s[8] === true,
            speed_kmh: typeof s[9] === "number" ? Math.round(s[9] * 3.6) : null,
            heading_deg: (s[10] as number | null) ?? null,
            vertical_rate_ms: (s[11] as number | null) ?? null,
          }))
          .filter((a) => typeof a.lat === "number" && typeof a.lon === "number")
          .map((a) => ({ ...a, distance_km: Math.round(haversineKm({ lat, lon }, { lat: a.lat!, lon: a.lon! }) * 10) / 10 }))
          .filter((a) => a.distance_km <= r)
          .sort((a, b) => a.distance_km - b.distance_km);
        const captured_at = typeof body.time === "number" ? new Date(body.time * 1000).toISOString() : null;
        const label = (a: (typeof aircraft)[number]) => `${a.callsign ?? a.icao24}${a.altitude_m != null ? ` ${Math.round(a.altitude_m)} m` : ""}`;
        return ok({
          kind: "value",
          value: aircraft.length,
          unit: "aircraft",
          captured_at,
          source: { name: "The OpenSky Network", url: "https://opensky-network.org", attribution: "The OpenSky Network" },
          note: `${aircraft.length} aircraft within ${r} km.`,
          data: {
            center: { lat, lon },
            radius_km: r,
            aircraft: aircraft.slice(0, 60),
            cached,
            ui: ui("map", { center: { lat, lon }, radius_km: r, markers: aircraft.slice(0, 60).map((a) => ({ lat: a.lat, lon: a.lon, label: label(a) })) }, `Aircraft · ${aircraft.length} nearby`),
          },
        });
      },
    },
  ],
});
