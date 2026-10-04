import { defineService, ok, reject, str, ui } from "./common";
import { geocode } from "./geo";

export const geocodeService = defineService({
  id: "geocode",
  name: "Place lookup · Open-Meteo Geocoding",
  vendor: "Open-Meteo",
  icon: "map-pin",
  source: { operator: "Open-Meteo (GeoNames)", url: "https://open-meteo.com/en/docs/geocoding-api", attribution: "GeoNames via Open-Meteo (CC BY 4.0)" },
  caps: [
    {
      capability_id: "place.geocode",
      title: "Find a place's coordinates",
      description: "Resolve a city / place name to latitude and longitude (up to 5 candidates). Use it before location-based capabilities like aircraft.nearby.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string", description: "Place name, e.g. 'Oakland' or 'Rome, Italy'." } },
        required: ["query"],
        additionalProperties: false,
      },
      async run(args, ctx) {
        const q = str(args.query, 120);
        if (!q) return reject("query is required");
        const places = await geocode(q, 5, ctx.signal);
        if (!places.length) return { state: "failed", error: `no place found for "${q}"` };
        const best = places[0];
        return ok({
          kind: "text",
          value: `${best.label}: ${best.lat.toFixed(4)}, ${best.lon.toFixed(4)}`,
          captured_at: null,
          source: { name: "Open-Meteo Geocoding (GeoNames)", url: "https://open-meteo.com/en/docs/geocoding-api" },
          data: {
            best,
            candidates: places,
            ui: ui("map", { center: { lat: best.lat, lon: best.lon }, zoom: 11, markers: places.slice(0, 1).map((p) => ({ lat: p.lat, lon: p.lon, label: p.label })) }, best.label),
          },
        });
      },
    },
  ],
});
