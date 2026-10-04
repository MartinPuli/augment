"use client";
import type { WidgetComponentProps } from "../../types";
import { card, col, sub } from "./styles";

interface Pt { lat: number; lon: number; label?: string }
interface Props { center?: { lat: number; lon: number }; zoom?: number; radius_km?: number; markers?: Pt[] }

/** OpenStreetMap embed iframe (one marker supported by OSM embed) + a list of all markers. */
export default function MapWidget({ props }: WidgetComponentProps<Props>) {
  const markers = (props.markers ?? []).filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lon));
  const c = props.center ?? markers[0] ?? { lat: 0, lon: 0 };
  // Bounding box: from radius, zoom, or the markers' extent.
  let span = props.radius_km ? props.radius_km / 111 : props.zoom ? 360 / 2 ** props.zoom : 0.05;
  if (!props.radius_km && !props.zoom && markers.length > 1) {
    span = Math.max(0.02, ...markers.map((m) => Math.max(Math.abs(m.lat - c.lat), Math.abs(m.lon - c.lon)))) * 1.2;
  }
  const latSpan = Math.min(85, span);
  const lonSpan = Math.min(180, span / Math.max(0.2, Math.cos((c.lat * Math.PI) / 180)));
  const bbox = [c.lon - lonSpan, c.lat - latSpan, c.lon + lonSpan, c.lat + latSpan].map((v) => v.toFixed(4)).join(",");
  const marker = markers.length === 1 ? `&marker=${markers[0].lat},${markers[0].lon}` : `&marker=${c.lat},${c.lon}`;
  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik${marker}`;
  return (
    <div style={col}>
      <div style={{ position: "relative", width: "100%", aspectRatio: "4 / 3", borderRadius: 14, overflow: "hidden" }}>
        <iframe src={src} title="Map" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0 }} loading="lazy" />
      </div>
      {markers.length > 1 && (
        <div style={{ ...card, maxHeight: 160, overflowY: "auto", padding: 8, display: "flex", flexDirection: "column", gap: 2 }}>
          {markers.slice(0, 40).map((m, i) => (
            <a
              key={i}
              href={`https://www.openstreetmap.org/?mlat=${m.lat}&mlon=${m.lon}#map=10/${m.lat}/${m.lon}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "#14161a", textDecoration: "none", fontSize: 13 }}
            >
              {m.label ?? `${m.lat.toFixed(3)}, ${m.lon.toFixed(3)}`}
            </a>
          ))}
        </div>
      )}
      <div style={{ ...sub, fontSize: 11 }}>© OpenStreetMap contributors</div>
    </div>
  );
}
