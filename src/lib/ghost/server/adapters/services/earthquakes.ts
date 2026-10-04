/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed third-party JSON */
import { defineService, fetchCached, numArg, ok, reject, ui } from "./common";

/** USGS earthquake GeoJSON feeds (keyless). https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php */

export const earthquakesService = defineService({
  id: "earthquakes",
  name: "Earthquakes · USGS",
  vendor: "USGS",
  icon: "activity",
  source: { operator: "U.S. Geological Survey", url: "https://earthquake.usgs.gov", attribution: "USGS Earthquake Hazards Program" },
  caps: [
    {
      capability_id: "earthquakes.recent",
      title: "Recent earthquakes worldwide",
      description: "Earthquakes in the past 24 hours worldwide (USGS), at or above min_magnitude (default 2.5): magnitude, place, time, depth, coordinates.",
      input_schema: {
        type: "object",
        properties: { min_magnitude: { type: "number", minimum: 0, maximum: 10, default: 2.5 } },
        additionalProperties: false,
      },
      async run(args, ctx) {
        const min = numArg(args.min_magnitude, 0, 10, 2.5);
        if (min === null) return reject("min_magnitude must be 0-10");
        const feed = min >= 4.5 ? "4.5_day" : min >= 2.5 ? "2.5_day" : min >= 1 ? "1.0_day" : "all_day";
        const url = `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${feed}.geojson`;
        const { body, cached } = await fetchCached<any>(url, { signal: ctx.signal });
        const quakes = (body.features ?? [])
          .map((f: any) => ({
            id: f.id,
            magnitude: f.properties?.mag as number | null,
            place: (f.properties?.place as string) ?? null,
            time: typeof f.properties?.time === "number" ? new Date(f.properties.time).toISOString() : null,
            url: f.properties?.url ?? null,
            tsunami: f.properties?.tsunami === 1,
            lon: f.geometry?.coordinates?.[0],
            lat: f.geometry?.coordinates?.[1],
            depth_km: f.geometry?.coordinates?.[2] ?? null,
          }))
          .filter((q: any) => typeof q.magnitude === "number" && q.magnitude >= min)
          .sort((a: any, b: any) => (b.time ?? "").localeCompare(a.time ?? ""));
        const generated = typeof body.metadata?.generated === "number" ? new Date(body.metadata.generated).toISOString() : null;
        const biggest = [...quakes].sort((a: any, b: any) => b.magnitude - a.magnitude)[0];
        const top = quakes.slice(0, 40);
        return ok({
          kind: "value",
          value: quakes.length,
          unit: "earthquakes (24 h)",
          captured_at: generated,
          source: { name: "USGS Earthquake Hazards Program", url: "https://earthquake.usgs.gov/earthquakes/map/" },
          note: biggest ? `${quakes.length} quakes ≥ M${min} in 24 h; largest M${biggest.magnitude} ${biggest.place}.` : `No quakes ≥ M${min} in 24 h.`,
          data: {
            min_magnitude: min,
            count: quakes.length,
            quakes: top,
            cached,
            ui: biggest
              ? ui("map", { center: { lat: biggest.lat, lon: biggest.lon }, zoom: 2, markers: top.map((q: any) => ({ lat: q.lat, lon: q.lon, label: `M${q.magnitude} ${q.place ?? ""}` })) }, `Earthquakes · last 24 h`)
              : ui("list", { items: [] }, "Earthquakes · last 24 h"),
          },
        });
      },
    },
  ],
});
