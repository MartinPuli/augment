# GHOST hardware framework

GHOST now includes an outbound LAN gateway and a versioned hardware-skill library available to any MCP agent and to Polty. The gateway runs where the hardware lives; the coordinator can run on Fly.io. A cloud server cannot discover a user's home network by scanning its own network.

## Connect hardware

Requires Node 22.13+ and the repository dependencies (`pnpm install`). Run on the owner’s computer or Raspberry Pi:

```sh
pnpm hardware:gateway --discover
```

For Home Assistant, set `HA_URL` and `HA_TOKEN` locally before discovery. Create a pairing in the GHOST owner interface, copy the code, then select the exact device keys printed by discovery:

```sh
pnpm hardware:gateway --coordinator https://YOUR-GHOST-HOST \
  --pair CODE --allow ha:light.kitchen --allow ha:sensor.workshop_temperature
```

Confirm the pending connector in GHOST. Only selected, supported, available devices are published. `--allow-all` is an explicit alternative that also includes supported devices found in future scans. For a restricted scan, use `--no-discovery` with Home Assistant or `--extra-hosts 'wled@192.168.1.50'`.

Devices connect outbound over WSS, without an inbound port on the owner’s router. GHOST authenticates the connector and applies its existing leases, quotas, budgets, cancellation and revocation. Owner usage is free; requests by other agents require owner approval by default, even at zero price. Owners can edit their offer terms separately. Payments still use the development ledger: these are not real rental settlements.

Gateway credentials are scoped to the coordinator origin, stored with mode 0600 in `.ghost/lan-gateway`, and reused after restart. Hardware credentials remain in the local environment. Device metadata sent to the coordinator omits LAN connection details. Do not put secrets in custom device names/descriptions.

The gateway refreshes every 30 seconds and unpublishes missing devices. Control failures are reported as unknown when the physical outcome cannot be established. Persistent action receipts prevent an invocation from executing again after restart. Keep the state directory across upgrades; deleting receipts discards that deduplication history. No automatic receipt pruning is implemented yet.

## Agent skill interface

- `list_hardware_guides(query?)`: lists packages, source revision and exact reference-file names.
- `read_hardware_guide(id, file?, offset?)`: reads an allowed file in chunks; follow `next_offset` for the rest.
- The same interface is available over HTTP at `/api/v1/hardware-guides` and `/api/v1/hardware-guides/:id`.

Included packages:

| Package | Purpose | Integration status |
| --- | --- | --- |
| `ghost-hardware` | Discover → inspect → obtain access → invoke → verify → release; connector recipes | First-party guide, implemented runtime |
| `home-assistant-best-practices` | Device control, automations, native configuration and reference docs | Pinned upstream MIT skill; HA runtime driver reused by gateway |
| `esp32-development` | Board identification, firmware frameworks, buses, sensors, ESPHome | Pinned upstream MIT skill; board access needs an owner connector/ESPHome instance |

Exact upstream URLs, revisions and allowed files are in `resources/hardware-skills/sources.json`. Upstream licenses are retained alongside each skill. Skill text is reference material: loading a skill does not execute its scripts, create hardware access or grant permission. Scripts and firmware templates are included as source references, not auto-run by GHOST.

## Capability coverage

Printer adapters now add OctoPrint and Moonraker/Klipper status, temperatures and explicitly enabled pause/resume/cancel. Setup and capability limits are in [the printer guide](../resources/hardware-skills/ghost-hardware/printers.md). API keys stay on the owner gateway; job controls are disabled by default.

Existing LAN drivers are reused: Home Assistant, Shelly, WLED, Tasmota, Elgato, already-paired Hue, legacy Kasa and Roku. Browser connectors already provide owner-authorized phone/laptop media, supported BLE profiles and the GHOST serial protocol. Public observation adapters include Caltrans and NOAA.

Viam remains a researched extension candidate, not an implemented GHOST adapter. Printer API behavior was tested with simulators; no physical print, robot movement or ESP32 flashing was performed. The framework does not discover arbitrary internet devices.

## Verification (2026-10-09)

- `pnpm hardware:printer-test`: **31 checks passed**, with two simulated printer APIs behind the real outbound gateway and MCP. Covered status/temperatures, explicit pause (no toggle), resume/cancel, idempotent retries, changed-file rejection, permission withdrawal, unconfirmed outcome, malformed replies and redirect refusal. Physical printer compatibility remains unverified.

- `pnpm hardware:test`: **23 checks passed** using labeled, loopback-only Home Assistant/WLED/Shelly simulators. Real coordinator, HTTP, WebSocket, MCP, owner confirmation, allowlisting, sensor value/timestamp, light readback, JPEG upload, visitor approval/revocation, reconnect identity, missing-device unpublish and persistent action receipts.
- `pnpm coord:smoke`: **75 passed, 0 failed**, including leases, exclusivity, test payments, quota, expiry, revocation and MCP image provenance.
- `pnpm exec tsx scripts/hardware-public-test.ts`: two actual read-only public-provider observations passed through MCP: NOAA station 9414290 reported 2.077 m MLLW at 2026-10-09 17:36 UTC; Caltrans TVD32 returned a Bay Bridge road image. Its structured capture timestamp was absent and remained null. The retrieved image visibly carries an operator timestamp; GHOST does not infer structured timestamps from image overlays.
- The full production Node/Next server also passed 19 HTTP/WebSocket/MCP checks on localhost, and served the main web pages and hardware guides with HTTP 200. Old local demo routing overrides were removed so the browser uses its current host.
- TypeScript check, targeted ESLint and production Next build passed. No physical private device was actuated. Simulator success establishes protocol behavior, not vendor hardware compatibility.

Live evidence is in the ignored `.ghost/hardware-public-evidence/` directory. Re-run the public test to obtain fresh data; the values above are test evidence, not current conditions.

## Deployment

Current status: production build prepared; Fly.io deployment is waiting for account sign-in. No new public deployment has been claimed or created.

Use the existing custom Node server and `fly.toml`: one coordinator instance with persistent `.ghost` storage and WebSocket support. Its Docker image includes `resources/hardware-skills`; connectors run separately at the hardware site. The production coordinator blocks LAN scanning unless an operator explicitly sets `GHOST_LOCAL_LAN_OWNER_ID` for a private LAN installation. Do not set that variable on a public cloud host.

The web can also be deployed separately, but Vercel Functions cannot host the device WebSocket server. Route API/MCP requests and device WebSockets to the same persistent coordinator. After deployment, verify `/api/v1/health`, the skills endpoint, and the deployed network test before calling the system online.
