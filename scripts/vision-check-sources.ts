/**
 * End-to-end check of the public-source adapters and the media proxy, without the coordinator:
 *   - Caltrans discover() + image.observe + video.stream invoke on a real camera
 *   - proxy: mount routes on a throwaway Hono app, fetch the rewritten playlist, follow it to a
 *     media chunklist and download a real segment through /proxy/seg; SSRF guard checks
 *   - NOAA discover() + every capability on every station
 *
 *   pnpm exec tsx scripts/vision-check-sources.ts [cameraQuery]
 */
import { Hono } from "hono";
import type { Device } from "../src/lib/ghost/contracts";
import { caltransAdapter } from "../src/lib/ghost/server/adapters/caltrans";
import { noaaAdapter } from "../src/lib/ghost/server/adapters/noaa";
import type { AdapterDiscovery, InvokeContext } from "../src/lib/ghost/server/adapters/types";
import { mountProxyRoutes } from "../src/lib/ghost/server/routes/proxy";

const query = (process.argv[2] ?? "SAS Tower").toLowerCase();
const log = (m: string) => console.log(`  [log] ${m}`);

function asDevice(d: AdapterDiscovery, adapter: string): Device {
  const now = new Date().toISOString();
  return {
    ...d.manifest,
    device_id: `dev_${d.manifest.local_key}`,
    owner_id: `provider:${adapter}`,
    connector_id: `internal:${adapter}`,
    status: d.status ?? "verified",
    online: d.online ?? true,
    last_heartbeat: null,
    created_at: now,
    updated_at: now,
  };
}

function ctx(): InvokeContext {
  return { invocation_id: "inv_test", visitor_id: "visitor_test", lease_id: null, deadline: new Date(Date.now() + 20000), signal: new AbortController().signal };
}

let failures = 0;
function check(ok: boolean, label: string, extra = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

async function caltrans(): Promise<string | null> {
  console.log("\n== Caltrans");
  const t0 = Date.now();
  const found = await caltransAdapter.discover!({ log });
  check(found.length > 0, "discover()", `${found.length} cameras in ${Date.now() - t0} ms`);
  const withStream = found.filter((d) => d.manifest.capabilities.some((c) => c.capability_id === "video.stream"));
  const pick =
    withStream.find((d) => d.manifest.name.toLowerCase().includes(query) && d.online) ??
    withStream.find((d) => d.online) ??
    found[0];
  if (!pick) return null;
  const dev = asDevice(pick, "caltrans");
  console.log(`  sample: ${dev.name} [${dev.local_key}] @ ${dev.location?.lat},${dev.location?.lon} (${dev.location?.label})`);
  console.log(`  caps: ${dev.capabilities.map((c) => `${c.capability_id}(${c.semantic_type})`).join(", ")}`);

  const still = await caltransAdapter.invoke(dev, "image.observe", {}, ctx());
  const o = still.observation;
  check(still.state === "succeeded", "image.observe", still.error ?? "");
  if (o?.media)
    console.log(
      `    content-type=${o.media.content_type} bytes=${o.media.bytes.byteLength} captured_at=${o.captured_at} operator_updated_at=${o.data?.operator_updated_at}\n    note: ${o.note}`,
    );

  const stream = await caltransAdapter.invoke(dev, "video.stream", {}, ctx());
  check(stream.state === "succeeded", "video.stream", stream.error ?? "");
  if (stream.observation?.stream) console.log(`    stream: ${JSON.stringify(stream.observation.stream)}\n    variants: ${JSON.stringify(stream.observation.data?.variants)}`);
  const bogus = await caltransAdapter.invoke(dev, "camera.pan", {}, ctx());
  check(bogus.state === "rejected", "no steering capability", bogus.error ?? "");
  return (stream.observation?.data?.upstream_url as string) ?? null;
}

async function proxy(upstream: string | null) {
  console.log("\n== Proxy");
  const root = new Hono();
  const v1 = new Hono();
  mountProxyRoutes(v1);
  root.route("/api/v1", v1);

  for (const bad of ["http://169.254.169.254/latest/meta-data", "https://evil.example.com/x.m3u8", "https://wzmedia.dot.ca.gov:8443/x.m3u8", "https://user:pw@wzmedia.dot.ca.gov/x.m3u8", "file:///etc/passwd"]) {
    const r = await root.request(`/api/v1/proxy/seg?u=${encodeURIComponent(bad)}`);
    check(r.status === 403, `rejects ${bad}`, `HTTP ${r.status}`);
  }
  if (!upstream) return;
  const r1 = await root.request(`/api/v1/proxy/hls?u=${encodeURIComponent(upstream)}`);
  const master = await r1.text();
  check(r1.status === 200 && r1.headers.get("access-control-allow-origin") === "*", "master playlist", `HTTP ${r1.status} ${r1.headers.get("content-type")}`);
  console.log(master.split("\n").map((l) => `    | ${l}`).join("\n"));
  const uriLines = master.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  check(uriLines.every((l) => l.startsWith("/api/v1/proxy/")), "all URI lines rewritten through proxy");
  let mediaPl = master;
  if (master.includes("#EXT-X-STREAM-INF")) {
    const r2 = await root.request(uriLines[0]);
    mediaPl = await r2.text();
    check(r2.status === 200, "variant (chunklist) playlist via proxy", `HTTP ${r2.status}`);
    console.log(mediaPl.split("\n").slice(0, 8).map((l) => `    | ${l}`).join("\n"));
  }
  const segs = mediaPl.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  check(segs.length > 0 && segs.every((l) => l.startsWith("/api/v1/proxy/seg?u=")), "segments rewritten to /proxy/seg");
  if (segs.length) {
    const t0 = Date.now();
    const r3 = await root.request(segs[segs.length - 1]);
    const buf = new Uint8Array(await r3.arrayBuffer());
    check(r3.status === 200 && buf[0] === 0x47, "segment download (MPEG-TS sync byte 0x47)", `HTTP ${r3.status} ${r3.headers.get("content-type")} ${buf.byteLength} bytes in ${Date.now() - t0} ms`);
  }
  // rewrite unit cases (keys / maps / renditions)
  const { rewritePlaylist } = await import("../src/lib/ghost/server/routes/proxy");
  const sample = [
    "#EXTM3U",
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x1',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/index.m3u8"',
    "#EXTINF:4,",
    "seg1.ts",
    "https://wzmedia.dot.ca.gov/other/seg2.ts",
  ].join("\n");
  const out = rewritePlaylist(sample, "https://wzmedia.dot.ca.gov/D4/x.stream/playlist.m3u8", "/api/v1/proxy");
  check(out.includes(`URI="/api/v1/proxy/seg?u=${encodeURIComponent("https://wzmedia.dot.ca.gov/D4/x.stream/key.bin")}"`), "rewrites EXT-X-KEY URI");
  check(out.includes(`URI="/api/v1/proxy/seg?u=${encodeURIComponent("https://wzmedia.dot.ca.gov/D4/x.stream/init.mp4")}"`), "rewrites EXT-X-MAP URI");
  check(out.includes(`URI="/api/v1/proxy/hls?u=${encodeURIComponent("https://wzmedia.dot.ca.gov/D4/x.stream/audio/index.m3u8")}"`), "rewrites EXT-X-MEDIA rendition to /hls");
  check(out.includes(`/api/v1/proxy/seg?u=${encodeURIComponent("https://wzmedia.dot.ca.gov/other/seg2.ts")}`), "rewrites absolute segment URL");
}

async function noaa() {
  console.log("\n== NOAA");
  const found = await noaaAdapter.discover!({ log });
  check(found.length === 5, "discover()", `${found.length} stations`);
  for (const d of found) {
    const dev = asDevice(d, "noaa");
    console.log(`  ${dev.name} [${d.status}] caps=${dev.capabilities.map((c) => c.capability_id).join(",")}`);
    for (const c of dev.capabilities) {
      const r = await noaaAdapter.invoke(dev, c.capability_id, {}, ctx());
      const o = r.observation;
      console.log(
        `    ${r.state === "succeeded" ? "ok  " : "FAIL"} ${c.capability_id.padEnd(23)} ${o ? `${o.value} ${o.unit ?? ""} captured_at=${o.captured_at} ${o.data?.quality ? `quality=${o.data.quality}` : ""}` : r.error}`,
      );
      if (r.state !== "succeeded") failures++;
    }
  }
  const sf = asDevice(found.find((d) => d.manifest.local_key === "station-9414290")!, "noaa");
  const missing = await noaaAdapter.invoke(sf, "water_temperature.read", {}, ctx());
  check(missing.state === "rejected", "SF station without water temp sensor rejects water_temperature.read", missing.error);
  const again = await noaaAdapter.invoke(sf, "water_level.read", {}, ctx());
  check(again.observation?.data?.cached === true, "60 s cache hit on repeat read");
  const pred = await noaaAdapter.invoke(sf, "tide.predict", { hours: 12 }, ctx());
  console.log(`    prediction note: ${pred.observation?.note}`);
  check(pred.observation?.captured_at === null && pred.observation?.data?.is_prediction === true, "prediction is flagged and has no captured_at");
}

async function main() {
  const upstream = await caltrans();
  await proxy(upstream);
  await noaa();
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
