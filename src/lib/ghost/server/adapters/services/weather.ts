/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed third-party JSON */
import { defineService, fetchCached, intArg, ok, reject, str, ui } from "./common";
import { geocode } from "./geo";

/** Open-Meteo forecast + air quality (keyless). https://open-meteo.com/en/docs */

const WMO: Record<number, string> = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Rime fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Dense drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains", 80: "Rain showers", 81: "Rain showers",
  82: "Violent rain showers", 85: "Snow showers", 86: "Heavy snow showers", 95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with hail",
};
const wmo = (c: unknown) => (typeof c === "number" ? WMO[c] ?? `Code ${c}` : null);

/** Open-Meteo returns local times without offset; convert with utc_offset_seconds. */
function localToIso(t: unknown, offsetS: number): string | null {
  if (typeof t !== "string") return null;
  const ms = Date.parse(`${t}Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms - offsetS * 1000).toISOString();
}

function aqiLabel(us: number | null): string | null {
  if (us === null) return null;
  if (us <= 50) return "Good";
  if (us <= 100) return "Moderate";
  if (us <= 150) return "Unhealthy for sensitive groups";
  if (us <= 200) return "Unhealthy";
  if (us <= 300) return "Very unhealthy";
  return "Hazardous";
}

const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export const weatherService = defineService({
  id: "weather",
  name: "Weather · Open-Meteo",
  vendor: "Open-Meteo",
  icon: "cloud-sun",
  source: { operator: "Open-Meteo", url: "https://open-meteo.com", attribution: "Weather data by Open-Meteo.com (CC BY 4.0)", conditions_url: "https://open-meteo.com/en/terms" },
  note: "Free Open-Meteo API (non-commercial use, CC BY 4.0).",
  caps: [
    {
      capability_id: "weather.forecast",
      title: "Weather now + forecast (any place)",
      description: "Current conditions and a 1-7 day daily forecast for any city or place name worldwide (model forecast, Open-Meteo). Temperatures °C, wind km/h.",
      input_schema: {
        type: "object",
        properties: {
          location: { type: "string", description: "City or place name, e.g. 'San Francisco' or 'Paris, France'." },
          days: { type: "integer", minimum: 1, maximum: 7, default: 3 },
        },
        required: ["location"],
        additionalProperties: false,
      },
      async run(args, ctx) {
        const location = str(args.location, 120);
        if (!location) return reject("location is required");
        const days = intArg(args.days, 1, 7, 3);
        if (days === null) return reject("days must be an integer 1-7");
        const [place] = await geocode(location, 1, ctx.signal);
        if (!place) return { state: "failed", error: `no place found for "${location}"` };
        const qs = new URLSearchParams({
          latitude: String(place.lat),
          longitude: String(place.lon),
          current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,precipitation,is_day",
          daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset",
          timezone: "auto",
          forecast_days: String(days),
        });
        const url = `https://api.open-meteo.com/v1/forecast?${qs}`;
        const { body, cached } = await fetchCached<Record<string, any>>(url, { signal: ctx.signal });
        const off = Number(body.utc_offset_seconds ?? 0);
        const c = body.current ?? {};
        const current = {
          time: localToIso(c.time, off),
          temperature_c: n(c.temperature_2m),
          feels_like_c: n(c.apparent_temperature),
          humidity_pct: n(c.relative_humidity_2m),
          wind_kmh: n(c.wind_speed_10m),
          wind_dir_deg: n(c.wind_direction_10m),
          precipitation_mm: n(c.precipitation),
          is_day: c.is_day === 1,
          code: n(c.weather_code),
          condition: wmo(c.weather_code),
        };
        const d = body.daily ?? {};
        const daily = (Array.isArray(d.time) ? d.time : []).map((date: string, i: number) => ({
          date,
          code: n(d.weather_code?.[i]),
          condition: wmo(d.weather_code?.[i]),
          max_c: n(d.temperature_2m_max?.[i]),
          min_c: n(d.temperature_2m_min?.[i]),
          precip_prob_pct: n(d.precipitation_probability_max?.[i]),
          sunrise: d.sunrise?.[i] ?? null,
          sunset: d.sunset?.[i] ?? null,
        }));
        const place_out = { name: place.label, lat: place.lat, lon: place.lon, timezone: body.timezone ?? place.timezone };
        return ok({
          kind: "value",
          value: current.temperature_c,
          unit: "°C",
          captured_at: current.time,
          source: { name: "Open-Meteo", url: "https://open-meteo.com", attribution: "Weather data by Open-Meteo.com" },
          note: `${place.label}: ${current.condition ?? "?"}, ${current.temperature_c ?? "?"} °C (feels ${current.feels_like_c ?? "?"} °C). Model-based current conditions and forecast, not a station measurement.`,
          data: { place: place_out, current, daily, units: { temperature: "°C", wind: "km/h", precipitation: "mm" }, cached, api_url: url, ui: ui("weather", { place: place_out, current, daily }, `Weather · ${place.name}`) },
        });
      },
    },
    {
      capability_id: "air_quality.read",
      title: "Air quality (any place)",
      description: "Current air quality for any city or place: US AQI, European AQI, PM2.5, PM10, ozone, NO2 (CAMS model via Open-Meteo).",
      input_schema: {
        type: "object",
        properties: { location: { type: "string", description: "City or place name." } },
        required: ["location"],
        additionalProperties: false,
      },
      async run(args, ctx) {
        const location = str(args.location, 120);
        if (!location) return reject("location is required");
        const [place] = await geocode(location, 1, ctx.signal);
        if (!place) return { state: "failed", error: `no place found for "${location}"` };
        const qs = new URLSearchParams({
          latitude: String(place.lat),
          longitude: String(place.lon),
          current: "us_aqi,european_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,carbon_monoxide",
          timezone: "auto",
        });
        const url = `https://air-quality-api.open-meteo.com/v1/air-quality?${qs}`;
        const { body, cached } = await fetchCached<Record<string, any>>(url, { signal: ctx.signal });
        const c = body.current ?? {};
        const off = Number(body.utc_offset_seconds ?? 0);
        const us = n(c.us_aqi);
        const reading = {
          time: localToIso(c.time, off),
          us_aqi: us,
          category: aqiLabel(us),
          european_aqi: n(c.european_aqi),
          pm2_5_ugm3: n(c.pm2_5),
          pm10_ugm3: n(c.pm10),
          ozone_ugm3: n(c.ozone),
          no2_ugm3: n(c.nitrogen_dioxide),
          co_ugm3: n(c.carbon_monoxide),
        };
        const place_out = { name: place.label, lat: place.lat, lon: place.lon };
        return ok({
          kind: "value",
          value: us,
          unit: "US AQI",
          captured_at: reading.time,
          source: { name: "Open-Meteo Air Quality (CAMS)", url: "https://open-meteo.com/en/docs/air-quality-api" },
          note: `${place.label}: US AQI ${us ?? "?"} (${reading.category ?? "unknown"}), PM2.5 ${reading.pm2_5_ugm3 ?? "?"} µg/m³. Modelled (CAMS), not a ground sensor.`,
          data: {
            place: place_out,
            ...reading,
            cached,
            api_url: url,
            ui: ui(
              "list",
              {
                items: [
                  { title: `US AQI ${us ?? "?"}`, subtitle: reading.category ?? "" },
                  { title: `PM2.5 ${reading.pm2_5_ugm3 ?? "?"} µg/m³`, subtitle: `PM10 ${reading.pm10_ugm3 ?? "?"} µg/m³` },
                  { title: `Ozone ${reading.ozone_ugm3 ?? "?"} µg/m³`, subtitle: `NO₂ ${reading.no2_ugm3 ?? "?"} µg/m³` },
                ],
              },
              `Air quality · ${place.name}`,
            ),
          },
        });
      },
    },
  ],
});
