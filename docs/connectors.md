# GHOST connectors

A **connector** is the only thing in GHOST that touches hardware. It knows the real interface
(getUserMedia, Web Bluetooth GATT, Web Serial, GPIO), publishes **device manifests** with bounded
**capabilities**, and connects **outbound** to the coordinator over an authenticated WebSocket
(`/v1/device-channel`). Agents never talk to hardware: they get a lease, the coordinator relays
an `invoke`, the connector does the work and answers with a `result` (media is uploaded first and
referenced by `observation_id`).

```
 phone / laptop / Pi / Arduino                 coordinator                       agent (Polty)
 ─────────────────────────────                 ───────────                       ─────────────
 connector ──hello(credential|owner_token|pairing_code)──▶
           ◀──welcome{credential} / pending_confirmation──
           ──publish{manifests}──▶ ◀──published{device_ids}
           ──heartbeat (5 s)──▶                 offline after 15 s
                                                ◀── lease + invoke ─────────────── agent
           ◀──invoke{invocation_id, lease_id, deadline, upload{url,token}}
           ──POST upload.url (Bearer token, X-Captured-At)──▶ {observation_id}
           ──result{state, output}──▶ ─────────────────────────────────────────▶ observation
           ◀──revoke / cancel / signal / ping
```

Protocol types live in `src/lib/ghost/contracts.ts` (`DeviceManifest`, `CapabilitySpec`,
`ConnectorMessage`, `CoordinatorMessage`).

## Rules every connector follows

- **Honesty.** A capability is published only when the API exists *and* permission was granted.
  A denied camera is not advertised. Unknown hardware is published as a *candidate* with no (or
  read-only) capabilities.
- **Bounded.** Every capability has a schema with limits (≤10 s audio, ≤3 Hz flashes, 0–180° servo,
  ≤280-char speech). Out-of-schema arguments are rejected. No arbitrary GPIO, shell, or GATT writes.
- **Verification is explicit.** `observation` (a fresh photo/reading is the evidence),
  `reported_state` (the device reports the resulting state), `acknowledgment` (only acknowledged —
  e.g. BLE lights have no readback, speech is not verified as heard).
- **Leases.** Invokes for revoked leases or past deadlines are rejected. On `revoke`, running work
  for that lease is aborted and live media (WebRTC) is closed.
- **Idempotent.** Results are cached by `invocation_id`; a retried invoke returns the same result
  without moving anything again. A physical action interrupted by a crash/timeout reports
  `unknown` and is **never auto-repeated**.

## Browser connector SDK (`src/lib/connector/`)

| File | What |
| --- | --- |
| `client.ts` | `GhostConnector`: hello/credential persistence (localStorage per connector kind), backoff reconnect, 5 s heartbeat, publish/unpublish, invoke dispatch with `ctx.upload/deadline/signal/lease_id`, revoked-lease set, results cache, offline result queue, `useSyncExternalStore`-ready snapshot (status, devices, active invocations, live sessions), WebRTC signal routing. |
| `local.ts` | `useLocalConnector()` — the desktop page's own connector (`desktop-browser`, owner_token, one socket per tab). `{status, devices, laptop, active, addBluetooth(profile?), addSerial(), enableWebcam(), enableMicrophone(), enableSpeaker(), disableLaptopModule(id), remove(local_key)}`. Also `getLocalConnector()`. |
| `webrtc.ts` | `openDeviceStream(deviceId): Promise<{stream, close()}>` (viewer) + `createStreamResponder` (device). STUN `stun:stun.l.google.com:19302`, signaling over the device channel. |
| `compose.ts` | Combine capability modules into one device ("Gabriele's iPhone", "This laptop"). |
| `drivers/camera.ts` | `camera.snapshot` (JPEG ≤1280 px via canvas `toBlob`), `camera.stream` (WebRTC), `torch.set` (only if `track.getCapabilities().torch`). |
| `drivers/microphone.ts` | `audio.level` (avg/peak dBFS over ≤10 s, not calibrated SPL), `audio.record` (≤10 s webm/opus or mp4 clip). |
| `drivers/speaker.ts` | `speaker.say` (speechSynthesis, ≤280 chars), `speaker.chime`. |
| `drivers/display.ts` | `display.show` (full-screen message), `display.flash` (≤3 Hz, ≤10 s). |
| `drivers/sensors.ts` | `haptics.vibrate`, `motion.read` (≤3 s), `location.read`, `battery.read`. |
| `drivers/bluetooth.ts` | Web Bluetooth profiles (below). |
| `drivers/serial.ts`, `drivers/serial-protocol.ts` | Web Serial + the GHOST serial line protocol. |
| `http.ts` | `getMe`, `createPairing`, `confirmPairing`, `rejectPairing`, `subscribeEvents`, `deviceChannelUrl`, `absoluteJoinUrl`. |

Minimal use:

```ts
const c = new GhostConnector({ url: deviceChannelUrl(), connectorKind: "desktop-browser", label: "Chrome on macOS", ownerToken });
c.registerDevice({ manifest, handler: async (capability_id, args, ctx) => ({ value: 42, unit: "°C" }) });
c.start();
```

### Phone (`/join`)

1. Owner opens the **Pair a phone** widget (`PairPhoneWidget`): it creates a one-use pairing
   (`POST /api/v1/pairings`) and shows a QR of `NEXT_PUBLIC_PUBLIC_ORIGIN + /join#code=XXXXXX`
   with a 2:00 countdown (regenerated on expiry).
2. The phone opens `/join`, reads the code from the URL **fragment** (never sent to servers in
   logs), scrubs it from the address bar and says `hello{pairing_code}` → `pending_confirmation`.
3. The widget receives `pairing.pending` over SSE and shows the phone's label with
   **Confirm / Reject**. Confirm → the phone gets `welcome{credential}` (stored in localStorage;
   later visits reconnect without a code).
4. On the phone the user turns sensors on one by one (each triggers the browser permission
   prompt), then taps **Publish device**. One manifest, `device_class: "phone"`.
5. While Polty uses a capability the phone is **possessed**: big ghost eyes and plain text
   ("Polty is looking through your camera"), a live camera peek, and a huge **Stop access**
   button that unpublishes the device and stops every camera/mic track. `display.show` takes over
   the screen. A screen wake lock is held while published; when the tab is hidden the device is
   reported offline (`device_status`) and invokes are rejected.

### Desktop ("This laptop", BLE, USB)

`ConnectHardwareWidget` (props `{transport?, profile?, reason?}`) shows big buttons because the
browser requires a click for every chooser/prompt. Results are published through
`useLocalConnector()` and announced to the agent with `emit("User connected … via …; capabilities: …")`.

### Live phone camera (WebRTC)

`openDeviceStream(deviceId)` creates a recvonly offer and sends
`{type:"signal", session_id, to:"device", data:{device_id, kind:"offer", sdp}}` over the desktop
tab's own device-channel socket. The coordinator checks the viewer may watch the device and relays
it to the phone, which answers with its camera track (`answer` / `ice` / `bye` / `error`). The
phone shows "Polty is watching live" while a peer connection is up; `revoke` or **Stop access**
closes it. Only STUN is configured: phone and laptop on very restrictive NATs may need a TURN server.

## Bluetooth LE profiles (Web Bluetooth)

| Profile | Detection | Capability | Verification |
| --- | --- | --- | --- |
| ELK-BLEDOM / MELK / LEDBLE LED strips | service `0xFFF0` char `0xFFF3` (name-matched) | `light.set {on?, color?, brightness?}` — `7e 00 04 f0 00 01 ff 00 ef` on, `7e 00 05 03 RR GG BB 00 ef` color, `7e 00 01 PP 00 00 00 00 ef` brightness (also sends the `7e 04 04 …` power variant) | acknowledgment |
| Triones / Happy Lighting / QHM / Magic Blue | service `0xFFD5`/`0xFFE5`, char `0xFFD9`/`0xFFE9` | `light.set` — `cc 23 33` on, `cc 24 33` off, `56 RR GG BB 00 f0 aa` color | acknowledgment |
| Heart-rate strap | `0x180D` / `0x2A37` notifications | `heart_rate.read {seconds≤10}` → median bpm | observation |
| Anything with Battery service | `0x180F` / `0x2A19` | `battery.read` → % | observation |
| Anything else | — | candidate; read-only `gatt.describe` (services + characteristic properties) | observation |

Byte tables follow the open-source `elkbledom` Home Assistant integration. `requestDevice` is called
first thing in the click; `optionalServices` lists every service above so the profiles are reachable.

## GHOST serial line protocol (Web Serial, Arduino/ESP32)

115200 baud, newline-delimited JSON.

```
host → ?\n
dev  → {"ghost":"0.1","name":"Desk Arduino","capabilities":[{"id":"servo.move","kind":"act","title":"Move servo","description":"…","params":{"angle":{"type":"number","minimum":0,"maximum":180}},"unit":"deg"}]}
host → {"id":"inv_123","cap":"servo.move","args":{"angle":90}}\n
dev  → {"id":"inv_123","ok":true,"value":90,"unit":"deg"}   |   {"id":"inv_123","ok":false,"error":"…"}
```

The browser waits ~1.5 s after opening (Arduinos reset on open), sends `?`, and maps each entry to a
`CapabilitySpec` (`params` → `input_schema`, act → `acknowledgment`, measure/observe →
`observation`). Arguments are validated against `params` before anything is written. No manifest
within 2.5 s → published as a candidate ("unknown protocol") with no capabilities. No reply to an
`act` → `unknown` (never retried).

Reference firmware: `connectors/arduino/ghost_serial/ghost_serial.ino` — `led.set` (built-in LED),
`servo.move` (D9, 0–180°, out of range rejected), `light.read` (A0, raw 0–1023).
Wiring: servo signal → D9, V+ → 5V, GND → GND (big servos: external 5V, common ground);
photoresistor from 5V to A0 with a 10 kΩ resistor from A0 to GND. See `connectors/arduino/README.md`.

## Raspberry Pi (`connectors/raspberry/`)

`ghost_pi.py` (Python 3.11+, asyncio + `websockets`). Pair once with a code from the owner console:

```bash
python ghost_pi.py --coordinator https://<ghost-host> --pair ABC123   # waits for owner confirmation
python ghost_pi.py --coordinator https://<ghost-host>                 # later runs reuse the stored credential
python ghost_pi.py --coordinator http://localhost:3000 --pair ABC123 --simulate   # no GPIO; labeled "(simulator)"
```

Publishes `cover.open` / `cover.close` (gpiozero `AngularServo`, calibrated pin/angles/pulse widths
from `config.toml`, optional `affects_view_of`), `cover.state`, and `camera.snapshot` if picamera2
finds a camera. Validates lease/deadline/arguments, keeps an on-disk results cache, writes an
in-flight marker before moving so a crash mid-move reports `unknown` (never repeated), and on revoke
stops accepting commands (moves only if `on_revoke = "close"`). Wiring, systemd unit and safety
notes: `connectors/raspberry/README.md`.

## Browser support

| Feature | Chrome / Edge desktop | Chrome Android | iOS Safari (and every iOS browser) | Firefox desktop |
| --- | --- | --- | --- | --- |
| Camera / mic (`getUserMedia`) | ✅ (HTTPS or localhost) | ✅ | ✅ | ✅ |
| Torch (`torch` constraint) | — | ✅ rear camera, most phones | ❌ | ❌ |
| Speech synthesis | ✅ | ✅ | ✅ after a tap (we unlock it on enable) | ✅ |
| Vibration | — | ✅ (after a tap) | ❌ | ❌ |
| Motion / orientation | — | ✅ | ✅ after permission button | — |
| Geolocation | ✅ | ✅ | ✅ | ✅ |
| Battery status | ✅ | ✅ | ❌ | ❌ |
| WebRTC live stream | ✅ | ✅ | ✅ | ✅ |
| **Web Bluetooth** | ✅ | ✅ | ❌ | ❌ |
| **Web Serial** | ✅ | ❌ | ❌ | ❌ |

**HTTPS is required** for camera, microphone, motion, location, Bluetooth and Serial (a "secure
context"). `http://localhost` counts as secure on the laptop, but a phone opening
`http://192.168.x.x:3000` does **not** — use the public HTTPS URL (Fly.io deploy or a tunnel such
as `cloudflared tunnel --url http://localhost:3000`) and set `NEXT_PUBLIC_PUBLIC_ORIGIN` to it so
the QR code points there. `/join` shows a warning when it is not in a secure context.

## Tested vs untested (honest status, Oct 4 2026)

Tested:
- `GhostConnector` protocol logic in Node against the mock coordinator
  (`pnpm exec tsx scripts/conn-ws-mock.ts` + `pnpm exec tsx scripts/conn-client-test.ts`, 21 checks):
  owner_token welcome, credential persistence + reconnect, publish, invoke, upload, idempotent
  retry, past-deadline rejection, act-timeout → `unknown`, revoke aborts + later rejects, cancel,
  signal relay, unpublish.
- Against the **real coordinator** (`GHOST_ORIGIN=… pnpm exec tsx scripts/conn-real-test.ts`):
  owner_token hello, publish, invoke round trip with media upload, phone pairing
  (code → pending → owner confirm → welcome → publish), signal relay viewer → phone → viewer,
  credential reconnect.
- `/join` in headless Chrome with a fake camera/mic (`scripts/conn-browser-e2e.ts`): pairing,
  permission toggles, publish, `camera.snapshot` JPEG through the real coordinator, possessed UI,
  `audio.level`, `display.show` takeover, Stop access.
- Serial protocol core in Node against a fake Arduino (`scripts/conn-serial-sim.ts`, 21 checks).
- Pi connector in `--simulate` mode against the mock (pairing, cover open/close/state, synthetic
  snapshot upload, idempotent retry, revoke, cancel, crash-mid-move → `unknown`, reconnect).
- Arduino sketch logic compiled with clang against stub Arduino headers and fed test lines.

Not tested on real hardware yet:
- Real phones (iOS Safari / Chrome Android) — permissions, torch, vibration, wake lock, WebRTC
  across NATs.
- Any real BLE light or heart-rate strap (byte protocols come from open-source docs; MELK/LEDBLE
  are lower confidence than ELK-BLEDOM/Triones).
- Web Serial with a physical Arduino; the sketch has not been built with the AVR toolchain.
- Raspberry Pi GPIO servo (gpiozero) and picamera2.

## Outbound LAN gateway

`pnpm hardware:gateway --discover` lists supported devices. Pair with `--coordinator https://HOST --pair CODE --allow LOCAL_KEY`, then confirm in GHOST. Home Assistant credentials stay on that gateway host. Unlike the browser SDK’s memory-only result cache, this Node gateway also persists action receipts across restarts. See [hardware-framework.md](hardware-framework.md).
