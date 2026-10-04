"use client";
import { useState } from "react";
import { MapPin } from "lucide";
import { Icon } from "@/components/ui/Icon";
import type { WidgetComponentProps } from "../../types";
import { EmptyState } from "./EmptyState";

interface Pt { lat: number; lon: number; label?: string }
interface Props { center?: { lat: number; lon: number }; zoom?: number; radius_km?: number; markers?: Pt[] }

/** OpenStreetMap embed iframe (one marker supported by OSM embed) + a list of all markers. */
export default function MapWidget({ props }: WidgetComponentProps<Props>) {
  const [loaded, setLoaded] = useState(false);
  const markers = (props.markers ?? []).filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lon));
  if (!props.center && !markers.length) {
    return <EmptyState illustration="map" fallback={MapPin} title="No place to show" subtitle="There's no location on this map yet." />;
  }
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
    <div className="flex min-w-0 flex-col gap-3">
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-tile bg-surface-2">
        {!loaded && <div aria-hidden className="ghost-skeleton absolute inset-0" />}
        <iframe src={src} title="Map" onLoad={() => setLoaded(true)} className="absolute inset-0 h-full w-full border-0" loading="lazy" />
      </div>
      {markers.length > 1 && (
        <ul className="ghost-scroll flex max-h-40 flex-col gap-0.5 overflow-y-auto">
          {markers.slice(0, 40).map((m, i) => (
            <li key={i}>
              <a
                href={`https://www.openstreetmap.org/?mlat=${m.lat}&mlon=${m.lon}#map=10/${m.lat}/${m.lon}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-h-10 min-w-0 items-center gap-2 rounded-tile px-3 text-body-sm text-fg transition-colors duration-150 ease-standard hover:bg-tint"
              >
                <Icon icon={MapPin} size={14} className="shrink-0 text-fg-3" />
                <span className="min-w-0 truncate tabular-nums">{m.label ?? `${m.lat.toFixed(3)}, ${m.lon.toFixed(3)}`}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      <p className="text-label text-fg-3">© OpenStreetMap contributors</p>
    </div>
  );
}
