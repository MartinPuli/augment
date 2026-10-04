# GHOST Raspberry Pi connector

`ghost_pi.py` lets a Raspberry Pi offer a **servo-driven cover**, and optionally a **camera**, to agents on GHOST.
The Pi connects **outbound** to the GHOST coordinator over an authenticated WebSocket (`/v1/device-channel`, protocol `ghost/0.1`).
Agents never connect to the Pi directly. You don't need to open any ports or set up port forwarding.

Published device: one `actuator` (transport `gpio`, access `own_device`) with:

| capability | kind | verification | what it does |
|---|---|---|---|
| `cover.open` / `cover.close` | act | `reported_state` | moves the servo to `open_angle` / `close_angle`. Returns `value: "open"/"closed"`, `data.angle` |
| `cover.state` | observe | `reported_state` | last **commanded** state, or `unknown` after a restart or an interrupted motion |
| `camera.snapshot` *(optional)* | observe | `observation` | fresh JPEG uploaded to the coordinator. Returns `observation_id`, `captured_at` |

The cover has **no position sensor**. "open"/"closed" means the connector commanded that angle and the motion finished. Point a camera at it (`affects_view_of`) if you need visual verification.

## Wiring

```
Servo (SG90 / MG90S)        Raspberry Pi
  signal (orange/yellow) -> GPIO18 (physical pin 12)
  V+     (red)           -> 5 V EXTERNAL supply (recommended), or pin 2/4 for a tiny unloaded SG90
  GND    (brown/black)   -> external supply GND  AND  a Pi GND pin (e.g. pin 6) - common ground is required
```

* Servos draw current spikes that can brown out the Pi. Use a separate 5 V supply for anything bigger than an unloaded SG90.
* Never connect the servo's V+ to a 3.3 V pin, and never feed 5 V into a GPIO pin.
* Camera: any Pi camera module on the CSI connector (on older OS images enable it with `raspi-config`).

## Install (Raspberry Pi OS Bookworm)

```bash
sudo apt install -y python3-venv python3-gpiozero python3-lgpio python3-picamera2   # picamera2 only if you have a camera
git clone <this repo> && cd <repo>/connectors/raspberry
python3 -m venv --system-site-packages .venv      # --system-site-packages makes the apt picamera2/lgpio importable
.venv/bin/pip install -r requirements.txt
cp config.example.toml config.toml && nano config.toml
```

`picamera2` is not pip-installable in a useful way. Install it with apt as shown above. If it's missing or no camera is detected, `camera.snapshot` is left out of the published capabilities.

## Pairing

1. The owner opens GHOST, goes to **Pair a device**, and gets a short code (for example `ABC123`).
2. On the Pi:
   ```bash
   .venv/bin/python ghost_pi.py --coordinator https://ghost.example.com --pair ABC123
   ```
   The Pi prints `Waiting for the owner to confirm in GHOST...`.
3. The owner confirms in GHOST. The coordinator sends a credential, which is stored in `~/.ghost-pi/credential.json` (mode 600). Change the location with `--state-dir`.
4. Later runs don't need `--pair`:
   ```bash
   .venv/bin/python ghost_pi.py --coordinator https://ghost.example.com
   ```

`http(s)://host` is mapped to `ws(s)://host/v1/device-channel`. If the connection drops, the connector reconnects with exponential backoff (1 s up to 30 s, with jitter) and sends a heartbeat every 5 s.

## Run as a service (systemd)

`/etc/systemd/system/ghost-pi.service`:

```ini
[Unit]
Description=GHOST Raspberry Pi connector
After=network-online.target
Wants=network-online.target

[Service]
User=pi
WorkingDirectory=/home/pi/ghost/connectors/raspberry
ExecStart=/home/pi/ghost/connectors/raspberry/.venv/bin/python ghost_pi.py --coordinator https://ghost.example.com
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now ghost-pi && journalctl -u ghost-pi -f
```

Pair once by hand (with `--pair`) as the same user before you enable the service. On SIGTERM the connector waits for any motion in progress to finish, then exits.

## Simulate mode (no Pi needed)

```bash
pip install websockets pillow       # Pillow is optional: it adds a synthetic camera.snapshot
python ghost_pi.py --simulate --pair ABC123 --coordinator http://localhost:3200 --state-dir /tmp/ghost-pi-sim
```

In simulate mode the connector never imports GPIO or camera code. Servo moves are logged and take about 600 ms. The device name gets a ` (simulator)` suffix and `meta.simulator: true`. The synthetic JPEG shows the simulated cover state.

To test against the mock coordinator from the repo root:

```bash
pnpm exec tsx scripts/conn-ws-mock.ts                      # port 3200 (MOCK_PORT)
curl localhost:3200/devices
curl -XPOST localhost:3200/invoke -H 'content-type: application/json' \
  -d '{"device_id":"dev_pi-cover","capability_id":"cover.open"}'
```

## Safety model

* **Fixed capabilities only.** The network can't run shell commands, pick GPIO pins or set angles. Angles come from `config.toml`. Invokes with any unexpected argument are rejected.
* **Validation.** The connector rejects an invoke (`state: "rejected"`) if its `local_key` or `device_id` doesn't match, if the capability is unknown, if the arguments aren't an object or contain extra keys, if the deadline is missing or already passed, or if its lease was revoked.
* **Revocation.** After `revoke`, all invokes for that lease are rejected, including ones queued behind a motion. The cover is **not** moved unless you set `on_revoke = "close"`.
* **Idempotency.** The last 200 results are cached and persisted in the state dir. A retried `invocation_id` gets the same result back without moving the servo again.
* **Crash safety.** An in-flight marker is written before each motion and removed after it. If the marker is still there at startup (power loss or crash mid-motion), the cover state is `unknown`, a warning is logged and a retry of that invocation is answered `unknown`. **Motion is never repeated automatically.** The servo also gets no pulses at boot (`initial_angle=None`).
* **Serialization.** Motions run one at a time (asyncio lock).
* **Cancel.** A `cancel` for an invocation that hasn't started gives `failed` / `"cancelled"`. A motion that has already started is not interrupted (stopping a servo halfway is not safer than letting it finish), and the result note says the cancel arrived late.

## Status

This connector has been **tested only in `--simulate` mode against the mock coordinator** (`scripts/conn-ws-mock.ts`). Those tests covered pairing, credential reuse, publish, cover open/close/state, synthetic snapshot upload, retries, past deadlines, revoke, cancel, crash markers and reconnect. **It has not yet been tested on a physical Raspberry Pi, servo or camera.** The GPIO and picamera2 code paths follow the gpiozero and picamera2 docs but haven't been run on hardware.
