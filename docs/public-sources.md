# Public sources & live vision

GHOST ships two documented public operators as in-process adapters, a CORS-safe media proxy, and an
in-browser object tracker that turns any live source into a "follow-cam" on the canvas.

| Piece | Code |
| --- | --- |
| Caltrans CCTV adapter | `src/lib/ghost/server/adapters/caltrans.ts` |
| NOAA CO-OPS adapter | `src/lib/ghost/server/adapters/noaa.ts` |
| HLS / image proxy | `src/lib/ghost/server/routes/proxy.ts` (`/api/v1/proxy/{hls,seg,image}`) |
| Vision (detector worker, tracker, follow-cam, HUD, sources) | `src/lib/vision/*` |
| Live view widget (`live_view`) | `src/components/canvas/widgets/LiveViewWidget.tsx` |
| Checks / tools | `scripts/vision-*` |

## Caltrans CCTV (`caltrans`, owner `provider:caltrans`)

- Catalog: `https://cwwp2.dot.ca.gov/data/d<N>/cctv/cctvStatusD0<N>.json` for each district in
  `GHOST_CALTRANS_DISTRICTS` (comma list, default `4` = Bay Area). The catalog is validated with zod;
  bad rows are skipped, a network failure logs and returns `[]` (boot never crashes).
- One device per camera, e.g. `TVD32 · I-80 Bay Bridge SAS Tower East`, `device_class: camera`,
  `transport: http-public`, `access_type: public_observation`, price 0, `zone_id: caltrans-d4`,
  location lat/lon + label, `icon: cctv`, `source` = Caltrans + catalog URL + attribution +
  <https://dot.ca.gov/conditions-of-use>. `inService=false` → `status: unavailable`, `online: false`.
  Camera URLs live in `device.meta` (`image_url`, `stream_url`, route, direction, county…).
- Capabilities (read-only road views — **no steering**, any other capability is rejected):
  - `image.observe` (kind `observe`, semantic `image.observe`, verification `observation`,
    `exclusive: false`): fetches `currentImageURL`, checks HTTP status, `image/*` MIME and ≤ 4 MB.
  - `video.stream` (kind `stream`, semantic `video.live`, `exclusive: false`, only when the catalog has
    an HLS URL): verifies the operator playlist answers with `#EXTM3U`, then returns an observation of
    kind `stream` with `stream: { kind: "hls", url: "/api/v1/proxy/hls?u=<encoded>", title }`.

### Provenance / freshness rules

- Stills: `captured_at = null`. Caltrans does not publish a capture time; the file's HTTP
  `Last-Modified` is stored as `data.operator_updated_at` (when the operator published the file) and the
  note says: *"Operator's latest published still; GHOST did not trigger the camera."*
  The catalog's `recordTimestamp` is the catalog record time, **not** a photo time (kept as
  `meta.catalog_record_time`).
- Streams: `captured_at = null`; note explains the stream is the operator's live HLS, proxied, typically
  ~10–30 s behind real time (10 s segments).
- Attribution `Caltrans CCTV, District <N>` travels with every observation.

## NOAA CO-OPS (`noaa`, owner `provider:noaa`)

Five curated San Francisco Bay stations. At discovery each station's sensors are read from the metadata
API (`/mdapi/prod/webapi/stations/<id>.json?expand=sensors`); sensors reported off are not offered. If the
metadata API is unreachable the curated product list (verified below) is used and the station is marked
`configured` instead of `verified`.

| Station | water_level.read | water_temperature.read | air_temperature.read | wind.read | tide.predict |
| --- | --- | --- | --- | --- | --- |
| 9414290 San Francisco (Golden Gate) | ✓ | — (sensor off) | ✓ | ✓ | ✓ |
| 9414750 Alameda | ✓ | ✓ | ✓ | ✓ | ✓ |
| 9414523 Redwood City | ✓ | — (sensor off) | ✓ | ✓ | ✓ |
| 9415020 Point Reyes | ✓ | ✓ | — | — | ✓ |
| 9414863 Richmond | ✓ | ✓ | ✓ | ✓ | ✓ |

- Measurements are `kind: measure`, verification `observation`; units `m` (water level, datum **MLLW**),
  `°C`, `m/s` (wind speed + gust; direction in degrees true, *from*).
- `captured_at` = NOAA's own timestamp (`t`, requested in GMT) converted to ISO-8601. Never the fetch time.
- Water level carries the quality flag (`q: "p"` → `preliminary`, `"v"` → `verified`) and sigma.
- `tide.predict` has its own semantic type **`water_level.predict`**, `captured_at: null`,
  `data.is_prediction: true` and a note starting with **"PREDICTION, not a measurement"**. It returns the
  high/low predictions for the next `hours` (1–72, default 24) and the next event as `value`.
- Missing data is reported honestly: NOAA "No data was found" → invocation `failed` with NOAA's message;
  an empty value → `failed` ("sensor gap"); readings older than 60 min succeed but the note says
  `Stale: latest reading is N min old.`
- Provider courtesy: responses are cached per station+product (60 s readings, 15 min predictions;
  `data.cached` tells the agent), every request carries `application=ghost`.

## Media proxy (`/api/v1/proxy/*`)

- `GET /proxy/hls?u=` fetches an `.m3u8` (≤ 1 MB, 10 s timeout) and rewrites **every** URI — variant
  playlists, segments, `#EXT-X-KEY` / `#EXT-X-MAP` / `#EXT-X-MEDIA` `URI="…"` attributes — to absolute
  upstream URLs routed back through the proxy (`/proxy/hls` for playlists, `/proxy/seg` otherwise).
- `GET /proxy/seg?u=` streams segments/keys with the upstream content-type (Range passthrough, 25 s
  timeout, 64 MB cap). `GET /proxy/image?u=` streams `image/*` only (8 MB cap) and exposes the upstream
  `Last-Modified`.
- **Strict allowlist** (no open proxy / SSRF): `wzmedia.dot.ca.gov`, `cwwp2.dot.ca.gov` plus hostnames in
  `GHOST_PROXY_ALLOW` (comma list). http(s) on default ports only, no credentials in URLs, redirects are
  followed manually and re-validated hop by hop. Disallowed → `403`. All responses send
  `Access-Control-Allow-Origin: *`.
- **CORS finding (2026-10-04 12:31 PT):** both Caltrans hosts already send
  `Access-Control-Allow-Origin: *` (wzmedia also sends `Access-Control-Allow-Credentials: true`, which is
  ignored for `*`). So direct playback would work; we still proxy to stay same-origin (tunnels, strict
  CSPs, never tainting the canvas the tracker reads) and to get timeouts and error mapping.

## Browser vision

- **Detector** (`detector.worker.ts` + `detector.ts`): a module Web Worker loads onnxruntime-web
  **1.30.0** from jsDelivr (pinned to the installed version; wasm paths on the same CDN) — WebGPU when an
  adapter is available, otherwise WASM SIMD (threads only if the page is cross-origin isolated, which the
  app is not). On a runtime WebGPU failure it falls back to WASM once.
  `createDetector(opts) → { ready, detect(bitmap), backend, model, input, busy, lastMs, dispose() }`.
  One frame in flight → adaptive frame skipping.
- **Preprocessing matters:** frames are resized into the 640×640 tensor with our own separable
  **Lanczos-3** resampler (`postprocess.ts`). On a Caltrans TVD32 frame D-FINE-N found 13 cars (≥ 0.3)
  with bilinear, ~24 with the browser canvas, 41 bicubic, **56–61 Lanczos**. Reducing the input to 512
  on WASM dropped that to 1 — every backend keeps 640.
- **Tiles** (`tiles.ts`): SAHI-style extra passes only for large sources (≥ 1.5× the model input, e.g.
  1280–1920 px webcams/phones) and only on fast backends; never upsampled (an upscaled crop of the Bay
  Bridge feed produced 0 cars).
- **Tracker** (`tracker.ts`): ByteTrack-lite — constant-velocity prediction, stage 1 high-score
  association (IoU with a centre-distance fallback for tiny fast objects), stage 2 low-score boxes against
  confirmed tracks, tentative→confirmed after 2 hits, 1.5 s max age (longer for slow `image_poll`),
  stable integer ids, trails, speed, velocity cap. Vehicle classes (car/truck/bus/train) may swap labels
  without losing identity.
- **Follow-cam** (`follow.ts`): explicit track id, or auto-pick among in-class tracks preferring
  established, confident, plausibly sized, *genuinely moving* tracks (net displacement over the trail, so
  jittery static look-alikes such as camera OSD text lose); lock held until the target is missing > 1.5 s,
  then re-acquired. Critically damped springs for centre and zoom, dead zone, crop clamped to the frame,
  `max_zoom` default 3×.

### `live_view` widget

```ts
props: {
  source: LiveSource; // hls | mjpeg | image_poll | local_camera | webrtc
  track?: {
    enabled?: boolean;          // default true when `track` is present; no `track` = plain player
    classes?: string[];         // COCO names; aliases like "cars", "people", "vehicles", "me" accepted
    follow?: boolean | number;  // true = auto-follow, number = lock this track id, false = no zoom
    max_zoom?: number;          // default 3 (clamped 1..6)
    model?: "dfine-n" | "yolov10n"; // default dfine-n
    backend?: "auto" | "webgpu" | "wasm";
  };
  title?: string;
}
```

- Click a box → locks it, `emit("User locked onto #12 (car)")` and `update({track:{…, follow: 12}})`.
  Clicking empty space while an explicit lock is active releases it back to auto-follow.
- `report()` once per second: `{ status, source_title, source_kind, tracking, classes, counts, total,
  follow_status, target: {id,label,confidence,speed_px_s,tracked_for_s} | null, zoom, fps, detect_fps,
  inference_ms, passes_per_cycle, backend, model, frame, error, note }`.
  `status` ∈ `connecting | loading_model | live | live_no_tracking | stream_unavailable |
  permission_denied | unsupported | error`. Counts are *confirmed tracks in the current frame*.
- Honest states: "Loading model… NN%", "Stream unavailable (HTTP 404)…", "Camera permission denied",
  "Live phone video is not available in this build" (if `@/lib/connector/webrtc` fails to import).

## Models & licenses

| Model | License | Use |
| --- | --- | --- |
| **D-FINE-N COCO** — `onnx-community/dfine_n_coco-ONNX` (`onnx/model.onnx`, 15.3 MB fp32; base `ustc-community/dfine-nano-coco`) | **Apache-2.0** | default |
| YOLOv10n — `onnx-community/yolov10n` (9.4 MB) | **AGPL-3.0** (Ultralytics/THU-MIG lineage) | only if `track.model = "yolov10n"`; also much worse on small highway cars (0–2 vs 41 on the same frame) |
| onnxruntime-web 1.30.0 (jsDelivr) | MIT | runtime |
| hls.js | Apache-2.0 | HLS playback |

Weights are **never committed**. The worker fetches them at runtime (Hugging Face sends CORS; the
redirect target `us.aws.cdn.hf.co` sends `access-control-allow-origin: *`) and keeps them in Cache
Storage (`ghost-vision-models-v1`). For flaky venue Wi-Fi run
`pnpm exec tsx scripts/vision-fetch-model.ts` once: it saves the weights to `public/vision/models/`
(git-ignored by `public/vision/models/.gitignore`) and the worker tries that same-origin copy first.

D-FINE I/O (verified from Node): input `pixel_values` float32 `[B,3,H,W]` (RGB, /255, no mean/std,
plain resize to 640×640); outputs `logits [B,300,80]` (sigmoid/focal) and `pred_boxes [B,300,4]`
(normalised cx,cy,w,h). YOLOv10n: input `images [1,3,640,640]` (letterbox, 114 pad), output
`output0 [1,300,6]` = x1,y1,x2,y2,score,class (NMS-free).

## Verification log (2026-10-04, PT)

- 12:30 Caltrans D4 catalog: HTTP 200, 2.4 MB, 756 cameras, 753 in service, 196 with HLS URLs.
  Bay Bridge streams: TVD32 SAS Tower East (live, 655×480 variant), TVD33 SAS Tower West (live,
  352×240), TVD36 SFOBB Incline (playlist OK but the feed shows "No video"), TVD22 Lower Deck (404).
- 12:31 TVD32 HLS: master → chunklist → `.ts` segment (515 KB, `video/MP2T`) all 200 with CORS `*`.
  Still `tv102…jpg`: 200 `image/jpeg`, 13 KB, `Last-Modified` present, CORS `*`.
- 12:37 NOAA: all 5 stations × all offered products returned data (water level `q: p` = preliminary).
  Alameda's `date=latest` water level once came back 3 days old — the adapter marks it stale.
- 12:40 `pnpm exec tsx scripts/vision-check-sources.ts` → **ALL CHECKS PASSED** (discover, still,
  stream, no-steering rejection, 5 SSRF rejections, playlist rewrite incl. KEY/MAP/MEDIA, real segment
  through `/proxy/seg`, NOAA readings, cache hit, prediction flagged).
- 12:51–13:25 Headless Chrome (WebGPU, Apple GPU) on the real widget bundle + real proxy
  (`scripts/vision-harness-server.ts`): TVD32 via `/api/v1/proxy/hls` → 60 FPS render, D-FINE-N
  ~50–70 ms per inference on WebGPU (~240 ms on WASM), ~12 detection cycles/s, 55–89 cars tracked,
  auto lock-on at 3× with minimap; WebGPU and WASM outputs identical on the same frame. `image_poll`
  via `/proxy/image`, `local_camera` (fake device) and the 404 / WebRTC-missing error states also
  verified.

## Scripts

- `scripts/vision-check-sources.ts` — adapters + proxy end-to-end (no server needed).
- `scripts/vision-model-check.ts [url]` — downloads both models, prints I/O shapes, runs them on a live
  frame (needs `ffmpeg`).
- `scripts/vision-tracker-replay.mts <png-dir> [fps]` — replays a frame sequence through detector +
  tracker (ID stability check).
- `scripts/vision-fetch-model.ts [dfine-n|yolov10n]` — optional same-origin model copy.
- `scripts/vision-harness/` + `scripts/vision-harness-server.ts` — standalone browser check of the real
  widget (no Next server): `node scripts/vision-harness/build.mjs /tmp/ghost-harness`, then
  `pnpm exec tsx scripts/vision-harness-server.ts /tmp/ghost-harness 4799` (serves the bundle with the
  real `/api/v1/proxy/*` mounted), then from the repo root
  `node scripts/vision-harness/cdp.mjs "http://localhost:4799/" 45 "20,45" /tmp/shot` (headless Chrome
  on debug port 9444, prints the widget's 1 Hz reports, saves screenshots; `CLICK_AT=sec,x,y` clicks).

## Known limits

- Tiny, low-contrast objects (distant cars on grey CCTV) get low confidences (0.15–0.35); counts are an
  estimate, and the camera's burned-in OSD text can occasionally be detected as a car.
- If the HLS player stalls > 1.5 s, tracks are re-created on resume (new ids).
- Cross-origin isolation is not enabled, so the WASM fallback is single-threaded (~3–4 FPS).
