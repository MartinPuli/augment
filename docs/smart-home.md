# GHOST smart-home layer (Wi-Fi / LAN)

"Polty, what's on my network?" → the coordinator scans the local network it runs on, fingerprints
devices with **documented local APIs**, publishes them as capabilities owned by the person who ran
the scan, and controls them through the normal lease → invoke flow.

Ground rules (enforced in code):

- Only documented local APIs. No default-credential guessing, no brute force, no exploits, no port
  scanning of address ranges. We probe only hosts that announced themselves (mDNS / SSDP / Kasa
  broadcast) or that you listed explicitly.
- Devices that need pairing (Hue link button, password-protected Shelly/Tasmota, Home Assistant
  without a token) are published as `candidate` with `meta.reason` + `meta.instructions`.
- Computers and phones (e.g. Macs announcing AirPlay) are **never published**. On shared Wi-Fi they
  are other people's devices; the scan reports only a count (`skipped_personal`).
- Secrets never go into manifests: Hue usernames live in `.ghost/lan.json` (gitignored, mode 600),
  the HA token stays in the environment.

## Code map

| Path | What |
| --- | --- |
| `src/lib/ghost/server/adapters/lan/index.ts` | `lanAdapter` (discover / invoke / probe), `rememberScan` |
| `.../lan/scan.ts` | `scan({ timeoutMs })`: mDNS + SSDP + Kasa UDP + TP-Link TDP + extra hosts → HTTP fingerprints |
| `.../lan/discovery/{mdns,ssdp}.ts` | bonjour-service browse; SSDP M-SEARCH per interface + description XML |
| `.../lan/drivers/*.ts` | Shelly, WLED, Tasmota, Elgato, Hue, Kasa, Roku, Home Assistant, candidates |
| `.../lan/store.ts` | `.ghost/lan.json` (Hue usernames, remembered devices, last owner, last scan) |
| `src/lib/ghost/server/routes/lan.ts` | `POST /api/v1/lan/scan`, `GET /api/v1/lan/status` |
| `src/components/canvas/widgets/NetworkScanWidget.tsx` | radar widget (`network_scan`) |
| `scripts/lan-fake-devices.ts` | **simulators** (not real hardware) |
| `scripts/lan-test.ts`, `scripts/lan-coord-test.ts` | driver tests / HTTP API tests against the simulators |

## Supported drivers

All LAN devices: `transport: "wifi-lan"`, `access_type: "own_device"`, price 0, zone `home-lan`
(Home Assistant entities use their HA area, e.g. `kitchen`). Verification is `reported_state`
when we read the state back after acting, `acknowledgment` when the device only acks.

| Driver | Discovery | Capabilities | Verification | Tested against |
| --- | --- | --- | --- | --- |
| Shelly Gen1 | mDNS `_http`/`_shelly`, `/shelly` | `switch.set {on}`, `switch.read`, `power.read` (W, if metered) | reported_state | **not tested** (code follows Gen1 docs) |
| Shelly Gen2+ (Plus/Pro) | mDNS `_shelly`, `/shelly` (`gen ≥ 2`) | same, via `/rpc/Switch.Set`, `/rpc/Switch.GetStatus` | reported_state | simulator only |
| WLED | mDNS `_wled`, `/json/info` | `light.set {on?, color?, brightness?}`, `light.effect {effect}`, `light.read` | reported_state | simulator only |
| Tasmota | `/cm?cmnd=Status 0` on HTTP hosts | `switch.set`, `switch.read`, `power.read` | reported_state | **not tested** |
| Elgato Key Light / Light Strip | mDNS `_elg` (:9123) | `light.set {on, brightness, temperature_k}` (strip: color), `light.read` | reported_state | **not tested** |
| Philips Hue bridge | mDNS `_hue`, SSDP `hue-bridgeid`, `/api/config` | bridge: `hue.pair`; each light: `light.set` (hex → CIE xy), `light.read`; Hue plugs: `switch.set/read` | ack (pair) / reported_state | simulator only |
| TP-Link Kasa (legacy firmware) | UDP broadcast :9999 (XOR autokey 171) | plugs/strips: `switch.set`, `switch.read`, `power.read` (HS110/KP115…); bulbs: `light.set`, `light.read` | reported_state | plug: simulator only; bulbs/strips **not tested** |
| TP-Link Kasa/Tapo (KLAP/AES firmware) | UDP :20002 TDP probe | candidate only (needs TP-Link cloud credentials) | — | **not tested** |
| Roku | SSDP `roku:ecp` (:8060) | `media.keypress {key}`, `media.launch {app_id}`, `media.read` | ack / reported_state (launch reads back the active app) | simulator only |
| Home Assistant | `HA_URL` + `HA_TOKEN` | per entity: light, switch/input_boolean, fan, cover, media_player, climate (bounded), sensor, binary_sensor, camera (snapshot), lock (read-only) | reported_state (polled read-back) | simulator only |

Seen but not controllable (published as `candidate`, `meta.support: "unsupported"`): HomeKit
(`_hap`), Google Cast, AirPlay receivers that are not computers (Apple TV, HomePod, TVs), printers
(`_ipp`/`_printer`), Sonos, ESPHome native API, UPnP media renderers / routers, unknown HTTP hosts.
At most 40 such entries per scan. Home Assistant announced over mDNS without a token is a
`needs_pairing` candidate with setup instructions.

Locks are deliberately read-only. Climate targets are clamped to the device range ∩ 10–30 °C
(50–86 °F).

### Honest test status (Oct 4 2026)

- Every driver marked "simulator" was exercised end-to-end against `scripts/lan-fake-devices.ts`,
  which emulates the documented APIs. **None of the drivers has been run against real hardware yet.**
- Real-network scans were run on (1) an IPv6-only phone hotspot — nothing found (no private IPv4
  LAN) — and (2) the venue Wi-Fi — ~56–61 Macs announcing AirPlay (all skipped as personal
  devices), no SSDP or Kasa replies, no smart-home devices.
- mDNS browse plumbing was verified with a locally published `_wled._tcp` record.

## HTTP API

`POST /api/v1/lan/scan` (auth: cookie or `Authorization: Bearer <owner_token>`)
body: `{ "timeout_ms"?: 1000–10000 }` (default 4000)

```jsonc
{
  "devices": [/* Device[] published under the caller */],
  "found": 15, "verified": 14, "candidates": 1, "skipped_personal": 56,
  "duration_ms": 4400,
  "interfaces": [{ "name": "en0", "address": "192.168.6.101", "cidr": "192.168.6.101/23", ... }],
  "sources": { "mdns": 56, "ssdp": 0, "kasa": 0, "extra": 5, "home_assistant": 10 },
  "errors": [], "note": "…", "scanned_at": "…", "cached": false
}
```

One scan per 5 s: the same caller gets the previous result with `cached: true` (or joins the
running scan); another caller gets 429. Devices remembered from earlier scans that did not
answer are re-published with `online: false`.

`GET /api/v1/lan/status` → `{ scanning, last_scan, home_assistant: { configured }, extra_hosts, paired_hue_bridges }`.

## Ownership

- `POST /lan/scan` publishes everything it found (LAN + Home Assistant) with `owner_id` = the caller
  and records that principal in `.ghost/lan.json`.
- At boot, `lanAdapter.discover()` re-publishes remembered LAN devices (probed for `online`) and
  imports Home Assistant entities under that remembered principal. If nobody has scanned yet, HA
  entities are owned by `provider:lan` as `owner_shared` at price 0; the first scan adopts them.

## Home Assistant setup (most universal path)

1. In HA: Profile → Security → **Long-lived access tokens** → Create.
2. Start the coordinator with
   `HA_URL=http://homeassistant.local:8123 HA_TOKEN=<token> pnpm dev`
3. "Polty, what's on my network?" (or restart): entities appear as devices, zoned by HA area.

Optional: `HA_MAX_ENTITIES` (default 250). Text-only sensors without a device class are skipped.
Anything HA can control (Tapo/KLAP plugs, HomeKit devices, Sonos, ESPHome, Zigbee…) becomes
reachable through this path.

## Hue pairing

The bridge shows up as a `candidate` with `hue.pair`. Press the round link button on the bridge,
then within 30 s ask Polty to pair it (invokes `hue.pair`). On success the username is stored in
`.ghost/lan.json`, the bridge becomes `verified` and each light is published as its own device.
Before the button is pressed, `hue.pair` fails with that instruction.

## Venue-network caveats

- Venue/hotel/conference Wi-Fi usually isolates clients and blocks multicast: expect only other
  attendees' laptops (which GHOST ignores). Use your home network or a phone hotspot that your
  devices are joined to.
- IPv6-only hotspots (464XLAT/CLAT, `192.0.0.2/32`) have no private IPv4 LAN; the scan says so.
- VPNs (Tailscale etc.) don't carry multicast; the scan uses the physical interfaces.
- Roku: *Settings → System → Advanced → Control by mobile apps* must allow network access.

## Testing with simulators (NOT real devices)

```bash
pnpm exec tsx scripts/lan-fake-devices.ts           # terminal 1 — every device is named "SIM …"
pnpm exec tsx scripts/lan-test.ts                   # scan + invoke every capability (49 checks)
pnpm exec tsx scripts/lan-coord-test.ts             # through the coordinator HTTP API (16 checks, port 3177, in-memory DB)
pnpm exec tsx scripts/lan-test.ts --real            # real network: discovery only
pnpm exec tsx scripts/lan-test.ts --real --read     # + read capabilities (only on YOUR network)
```

To point a running coordinator at the simulators (testing only — mDNS can't see localhost):

```bash
GHOST_LAN_EXTRA_HOSTS="127.0.0.1:8081,127.0.0.1:8082,127.0.0.1:8083,roku@127.0.0.1:8084,kasa@127.0.0.1:9999" \
HA_URL=http://127.0.0.1:8124 HA_TOKEN=sim-token pnpm dev
```

`GHOST_LAN_EXTRA_HOSTS` entries are `[driver@]host[:port]` (driver ∈ shelly, wled, tasmota, hue,
elgato, roku, kasa); listed hosts are probed directly. Other env: `GHOST_LAN_STORE` (store path),
`GHOST_LAN_NO_PUBLISH` (scripts: never touch the catalog DB).
