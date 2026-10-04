"use client";
import type { WidgetComponentProps } from "../../types";
import { card, col, fmtTime, sub } from "./styles";

interface Dep { destination: string; minutes: number; leaving?: boolean; platform?: string | null; cars?: number | null; hexcolor?: string | null; cancelled?: boolean }
interface Props { station?: string; departures?: Dep[]; updated_at?: string | null }

export default function DeparturesWidget({ props }: WidgetComponentProps<Props>) {
  return (
    <div style={{ ...col, gap: 6 }}>
      {(props.departures ?? []).slice(0, 12).map((d, i) => (
        <div key={i} style={{ ...card, display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", opacity: d.cancelled ? 0.5 : 1 }}>
          <span style={{ width: 10, height: 10, borderRadius: 5, background: d.hexcolor ?? "#999", flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0, fontWeight: 600 }}>{d.destination}</span>
          <span style={sub}>P{d.platform}{d.cars ? ` · ${d.cars} cars` : ""}</span>
          <span style={{ fontWeight: 700, width: 64, textAlign: "right" }}>{d.leaving ? "Now" : `${d.minutes} min`}</span>
        </div>
      ))}
      {!props.departures?.length && <div style={sub}>No departures listed.</div>}
      {props.updated_at && <div style={{ ...sub, fontSize: 11 }}>Updated {fmtTime(props.updated_at)} · BART</div>}
    </div>
  );
}
