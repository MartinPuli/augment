import { createRoot } from "react-dom/client";
import LiveViewWidget from "@/components/canvas/widgets/LiveViewWidget";
import type { LiveSource } from "@/lib/ghost/contracts";

const q = new URLSearchParams(location.search);
const upstream = q.get("u") ?? "https://wzmedia.dot.ca.gov/D4/W80_at_SAS_Tower.stream/playlist.m3u8";
const source: LiveSource = q.get("kind") === "local_camera" ? { kind: "local_camera", title: "This laptop" } : q.get("kind") === "webrtc" ? { kind: "webrtc", device_id: "dev_nonexistent", title: "Phone" } : q.get("kind") === "image_poll"
  ? { kind: "image_poll", url: `/api/v1/proxy/image?u=${encodeURIComponent(upstream)}`, interval_ms: 3000, title: "still poll" }
  : { kind: "hls", url: `/api/v1/proxy/hls?u=${encodeURIComponent(upstream)}`, title: "TVD32 · I-80 Bay Bridge SAS Tower East · Caltrans live" };
const classes = (q.get("classes") ?? "car,truck").split(",").filter(Boolean);
const w = window as unknown as { __reports: Record<string, unknown>[] };
w.__reports = [];
function App() {
  return (
    <div style={{ width: 900, padding: 16 }} className="bg-ink-2">
      <LiveViewWidget
        id="t"
        focused
        props={{ source, track: { enabled: true, classes, follow: true, max_zoom: 3 } }}
        report={(d) => {
          w.__reports.push(d);
          console.log("REPORT " + JSON.stringify(d));
        }}
        emit={(t) => console.log("EMIT " + t)}
        update={(p) => console.log("UPDATE " + JSON.stringify(p))}
      />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
