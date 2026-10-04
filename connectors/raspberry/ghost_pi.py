#!/usr/bin/env python3
"""GHOST Raspberry Pi connector (protocol ghost/0.1).

Connects OUTBOUND to a GHOST coordinator over the authenticated device channel
(ws(s)://<host>/v1/device-channel) and publishes one device: a servo-driven cover
(cover.open / cover.close / cover.state) plus an optional camera.snapshot.

Only these fixed capabilities are exposed. The network can never run shell
commands or touch arbitrary GPIO pins.

    python ghost_pi.py --coordinator https://ghost.example --pair ABC123
    python ghost_pi.py --coordinator http://localhost:3200 --simulate --pair ABC123
"""
from __future__ import annotations

import argparse
import asyncio
import io
import json
import logging
import os
import random
import signal
import socket
import sys
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from websockets.asyncio.client import connect
    from websockets.exceptions import ConnectionClosed
except ImportError:  # pragma: no cover
    sys.exit("The 'websockets' package (>=13) is required: pip install -r requirements.txt")

PROTOCOL_VERSION = "ghost/0.1"
CONNECTOR_VERSION = "0.1.0"
HEARTBEAT_S = 5
RESULT_CACHE_SIZE = 200
MAX_REVOKED = 1000

log = logging.getLogger("ghost-pi")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_iso(s: Any) -> datetime | None:
    if not isinstance(s, str) or len(s) > 64:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def write_private(path: Path, data: Any) -> None:
    """Atomically write JSON readable only by the current user (chmod 600)."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


# --------------------------------------------------------------------------- config

DEFAULT_CONFIG: dict[str, Any] = {
    "label": socket.gethostname(),
    "name": "Pi cover",
    "local_key": "pi-cover",
    "zone_id": None,
    "price_cents": 0,
    "max_duration_s": 600,
    "affects_view_of": None,
    "on_revoke": "none",  # "none" | "close"
    "servo": {
        "pin": 18,
        "min_pulse_width_ms": 0.5,
        "max_pulse_width_ms": 2.5,
        "min_angle": 0,
        "max_angle": 180,
        "open_angle": 90,
        "close_angle": 0,
        "settle_ms": 700,
        "detach_after_move": True,
    },
    "camera": {"enabled": True, "width": 1280, "height": 720},
}


def load_config(path: Path | None) -> dict[str, Any]:
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    if path:
        with open(path, "rb") as f:
            user = tomllib.load(f)
        for k, v in user.items():
            if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                cfg[k].update(v)
            else:
                cfg[k] = v
    s = cfg["servo"]
    for key in ("open_angle", "close_angle"):
        if not (s["min_angle"] <= s[key] <= s["max_angle"]):
            raise SystemExit(f"config: servo.{key}={s[key]} outside [{s['min_angle']}, {s['max_angle']}]")
    if cfg["on_revoke"] not in ("none", "close"):
        raise SystemExit('config: on_revoke must be "none" or "close"')
    if not isinstance(cfg["price_cents"], int) or cfg["price_cents"] < 0:
        raise SystemExit("config: price_cents must be a non-negative integer")
    return cfg


# --------------------------------------------------------------------------- hardware

class SimServo:
    def __init__(self) -> None:
        log.info("SIMULATOR: no GPIO is used")

    def move(self, angle: float) -> None:
        log.info("SIMULATOR: servo -> %s deg", angle)
        time.sleep(0.6)

    def close(self) -> None:
        pass


class GpioServo:
    def __init__(self, s: dict[str, Any]) -> None:
        from gpiozero import AngularServo  # imported only on real hardware

        # initial_angle=None: send no pulses at startup, so the servo never moves on boot.
        self.servo = AngularServo(
            int(s["pin"]),
            initial_angle=None,
            min_angle=s["min_angle"],
            max_angle=s["max_angle"],
            min_pulse_width=float(s["min_pulse_width_ms"]) / 1000,
            max_pulse_width=float(s["max_pulse_width_ms"]) / 1000,
        )
        self.settle_s = float(s["settle_ms"]) / 1000
        self.detach = bool(s["detach_after_move"])
        log.info("servo on GPIO%s ready (not moved)", s["pin"])

    def move(self, angle: float) -> None:
        self.servo.angle = angle
        time.sleep(self.settle_s)
        if self.detach:
            self.servo.detach()  # stop pulses: avoids jitter/heat; servo holds by friction only

    def close(self) -> None:
        self.servo.close()


class SimCamera:
    def __init__(self, conn: "Connector") -> None:
        from PIL import Image, ImageDraw  # noqa: F401  (raises ImportError if Pillow missing)

        self.conn = conn

    def capture_jpeg(self) -> bytes:
        from PIL import Image, ImageDraw

        img = Image.new("RGB", (320, 240), (24, 26, 32))
        d = ImageDraw.Draw(img)
        state = self.conn.cover_state
        if state == "closed":
            d.rectangle([0, 0, 320, 240], fill=(70, 60, 50))
            for y in range(0, 240, 16):
                d.line([0, y, 320, y], fill=(110, 95, 80), width=3)
        else:
            d.rectangle([110, 70, 210, 170], fill=(220, 160, 40))
        d.text((8, 8), "GHOST Pi simulator", fill=(255, 255, 255))
        d.text((8, 24), now_iso(), fill=(200, 200, 200))
        d.text((8, 220), f"cover: {state}", fill=(255, 255, 255))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=80)
        return buf.getvalue()

    def close(self) -> None:
        pass


class PiCamera:
    def __init__(self, c: dict[str, Any]) -> None:
        from picamera2 import Picamera2

        if not Picamera2.global_camera_info():
            raise RuntimeError("no camera detected")
        self.cam = Picamera2()
        self.cam.configure(self.cam.create_still_configuration(main={"size": (int(c["width"]), int(c["height"]))}))
        self.cam.start()
        time.sleep(1.0)  # let auto-exposure settle

    def capture_jpeg(self) -> bytes:
        buf = io.BytesIO()
        self.cam.capture_file(buf, format="jpeg")
        return buf.getvalue()

    def close(self) -> None:
        self.cam.close()


# --------------------------------------------------------------------------- capabilities

EMPTY_INPUT = {"type": "object", "properties": {}, "additionalProperties": False}


def build_manifest(cfg: dict[str, Any], simulate: bool, has_camera: bool) -> dict[str, Any]:
    s = cfg["servo"]
    honest = ("Verification is reported_state: the connector reports the angle it commanded. "
              "The physical position is not sensed.")
    cover_out = {"schema": {"type": "object", "properties": {
        "value": {"enum": ["open", "closed"]}, "data": {"type": "object"}}}}

    def cover_cap(cid: str, title: str, angle: float) -> dict[str, Any]:
        cap = {
            "capability_id": cid, "kind": "act", "semantic_type": cid, "title": title,
            "description": f"Moves the cover servo to {angle} deg. {honest}",
            "input_schema": EMPTY_INPUT, "output": cover_out, "limits": {"rate_per_min": 20},
            "verification": "reported_state", "concurrency_group": "cover", "exclusive": True,
            "estimated_ms": 800,
        }
        if cfg.get("affects_view_of"):
            cap["affects_view_of"] = str(cfg["affects_view_of"])
        return cap

    caps = [
        cover_cap("cover.open", "Open cover", s["open_angle"]),
        cover_cap("cover.close", "Close cover", s["close_angle"]),
        {
            "capability_id": "cover.state", "kind": "observe", "semantic_type": "cover.state",
            "title": "Cover state",
            "description": "Last commanded cover state (open/closed), or unknown after a restart or an "
                           "interrupted motion. Not sensed.",
            "input_schema": EMPTY_INPUT,
            "output": {"schema": {"type": "object", "properties": {"value": {"enum": ["open", "closed", "unknown"]}}}},
            "verification": "reported_state", "exclusive": False, "estimated_ms": 50,
        },
    ]
    if has_camera:
        caps.append({
            "capability_id": "camera.snapshot", "kind": "observe", "semantic_type": "image.observe",
            "title": "Camera snapshot",
            "description": ("Synthetic JPEG from the simulator (not a real camera)." if simulate
                            else "Fresh JPEG from the Raspberry Pi camera."),
            "input_schema": EMPTY_INPUT, "output": {"media": "image/jpeg"},
            "limits": {"rate_per_min": 30, "max_payload_bytes": 5_000_000},
            "verification": "observation", "concurrency_group": "camera", "exclusive": False,
            "estimated_ms": 1500,
        })
    model = None
    try:
        model = Path("/proc/device-tree/model").read_text().strip("\x00\n ") or None
    except OSError:
        pass
    manifest: dict[str, Any] = {
        "protocol_version": PROTOCOL_VERSION,
        "local_key": cfg["local_key"],
        "name": cfg["name"] + (" (simulator)" if simulate else ""),
        "device_class": "actuator",
        "transport": "gpio",
        "vendor": "Raspberry Pi",
        "access_type": "own_device",
        "terms": {"price_cents": cfg["price_cents"], "currency": "USD", "max_duration_s": int(cfg["max_duration_s"])},
        "capabilities": caps,
        "icon": "blinds",
        "meta": {"connector": "ghost_pi.py", "connector_version": CONNECTOR_VERSION, "simulator": simulate},
    }
    if model and not simulate:
        manifest["model"] = model
    if cfg.get("zone_id"):
        manifest["zone_id"] = str(cfg["zone_id"])
    return manifest


class Rejected(Exception):
    pass


# --------------------------------------------------------------------------- connector

class Connector:
    def __init__(self, args: argparse.Namespace, cfg: dict[str, Any]) -> None:
        self.args, self.cfg = args, cfg
        self.ws_url = to_ws_url(args.coordinator)
        self.state_dir = Path(args.state_dir).expanduser()
        self.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.cred_path = self.state_dir / "credential.json"
        self.marker_path = self.state_dir / "inflight.json"
        self.results_path = self.state_dir / "results.json"
        self.local_key: str = cfg["local_key"]
        self.device_id: str | None = None
        self.ws: Any = None
        self.send_lock = asyncio.Lock()
        self.motion_lock = asyncio.Lock()
        self.camera_lock = asyncio.Lock()
        self.stopping = asyncio.Event()
        self.results: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self.running: dict[str, asyncio.Task[Any]] = {}
        self.started: set[str] = set()
        self.cancelled: set[str] = set()
        self.revoked: OrderedDict[str, None] = OrderedDict()
        self.outbox: list[dict[str, Any]] = []
        self.cover_state = "unknown"
        self.angle: float | None = None
        self.last_commanded_at: str | None = None
        self.state_note = "No motion commanded since the connector started; position unknown."
        self.interrupted: dict[str, Any] | None = None
        self.pair_code: str | None = args.pair
        self.cred_rejected = False
        self.exit_code = 0

        self._load_results()
        if self.marker_path.exists():
            try:
                self.interrupted = json.loads(self.marker_path.read_text())
            except (OSError, ValueError):
                self.interrupted = {"invocation_id": None}
            log.warning("A motion was in flight when the connector stopped (%s). Cover state is UNKNOWN; "
                        "the motion will NOT be repeated automatically.", self.interrupted)
            self.state_note = "A previous motion was interrupted (power loss/crash); position unknown."
            inv = self.interrupted.get("invocation_id")
            if isinstance(inv, str) and inv not in self.results:
                # A retry of that invocation must never repeat the motion: answer "unknown" from the cache.
                self.results[inv] = {"type": "result", "invocation_id": inv, "state": "unknown",
                                     "error": "motion was in flight when the connector stopped; outcome unknown, "
                                              "not repeated"}
                write_private(self.results_path, dict(self.results))
            self.marker_path.unlink(missing_ok=True)

        self.servo: SimServo | GpioServo = SimServo() if args.simulate else GpioServo(cfg["servo"])
        self.camera: SimCamera | PiCamera | None = None
        if cfg["camera"].get("enabled", True):
            try:
                self.camera = SimCamera(self) if args.simulate else PiCamera(cfg["camera"])
                log.info("camera.snapshot enabled (%s)", "synthetic" if args.simulate else "picamera2")
            except Exception as e:  # ImportError, no camera, busy camera...
                log.info("camera.snapshot disabled: %s", e)
        self.manifest = build_manifest(cfg, args.simulate, self.camera is not None)
        self.caps = {c["capability_id"]: c for c in self.manifest["capabilities"]}

    # ---------------- persistence
    def _load_results(self) -> None:
        try:
            for k, v in json.loads(self.results_path.read_text()).items():
                self.results[k] = v
        except (OSError, ValueError):
            pass

    def load_credential(self) -> str | None:
        try:
            data = json.loads(self.cred_path.read_text())
        except (OSError, ValueError):
            return None
        if data.get("coordinator") != self.ws_url:
            log.warning("stored credential is for %s, not %s; ignoring it", data.get("coordinator"), self.ws_url)
            return None
        return data.get("credential")

    # ---------------- transport
    async def send(self, msg: dict[str, Any]) -> bool:
        ws = self.ws
        if ws is None:
            return False
        try:
            async with self.send_lock:
                await ws.send(json.dumps(msg))
            if msg["type"] != "heartbeat":
                log.debug("-> %s", msg)
            return True
        except ConnectionClosed:
            return False

    async def run(self) -> None:
        if not self.load_credential() and not self.pair_code:
            log.error("No stored credential in %s. Pair first: python ghost_pi.py --coordinator %s --pair CODE",
                      self.state_dir, self.args.coordinator)
            self.exit_code = 2
            self.stopping.set()
            return
        backoff = 1.0
        while not self.stopping.is_set():
            try:
                async with connect(self.ws_url, open_timeout=15, ping_interval=20, ping_timeout=20,
                                   max_size=1 << 20, user_agent_header=f"ghost-pi/{CONNECTOR_VERSION}") as ws:
                    log.info("connected to %s", self.ws_url)
                    self.ws = ws
                    if await self.session(ws):
                        backoff = 1.0
            except ConnectionClosed as e:
                log.warning("connection closed: %s", e)
            except (OSError, asyncio.TimeoutError) as e:
                log.warning("cannot reach coordinator: %s", e)
            except Exception as e:  # handshake errors etc.
                log.warning("connection error: %r", e)
            finally:
                self.ws = None
            if self.stopping.is_set():
                break
            delay = min(30.0, backoff) * random.uniform(0.7, 1.3)
            log.info("reconnecting in %.1fs", delay)
            try:
                await asyncio.wait_for(self.stopping.wait(), timeout=delay)
            except asyncio.TimeoutError:
                pass
            backoff = min(30.0, backoff * 2)

    async def session(self, ws: Any) -> bool:
        """One connection. Returns True if we were welcomed (resets backoff)."""
        hello: dict[str, Any] = {"type": "hello", "protocol_version": PROTOCOL_VERSION,
                                 "connector_kind": "raspberry-pi", "label": str(self.cfg["label"])}
        cred = None if (self.cred_rejected and self.pair_code) else self.load_credential()
        if cred:
            hello["credential"] = cred
        elif self.pair_code:
            hello["pairing_code"] = self.pair_code
            hello["nonce"] = os.urandom(12).hex()
        else:
            log.error("No stored credential. Pair first: python ghost_pi.py --coordinator %s --pair CODE",
                      self.args.coordinator)
            self.stopping.set()
            return False
        await self.send(hello)
        welcomed = False
        hb: asyncio.Task[Any] | None = None
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                    assert isinstance(msg, dict) and isinstance(msg.get("type"), str)
                except (ValueError, AssertionError):
                    log.warning("ignoring malformed message")
                    continue
                t = msg["type"]
                if t != "ping":
                    log.debug("<- %s", msg)
                if t == "pending_confirmation":
                    print(f"\n  Waiting for the owner to confirm in GHOST... (pairing {msg.get('pairing_id')})\n"
                          f"  {msg.get('message', '')}\n", flush=True)
                elif t == "welcome":
                    if isinstance(msg.get("credential"), str) and msg["credential"]:
                        write_private(self.cred_path, {"coordinator": self.ws_url, "credential": msg["credential"],
                                                       "connector_id": msg.get("connector_id"),
                                                       "owner_id": msg.get("owner_id"), "saved_at": now_iso()})
                    self.pair_code = None  # one-use; from now on the credential is used
                    welcomed = True
                    log.info("welcomed as %s (owner %s); credential saved to %s",
                             msg.get("connector_id"), msg.get("owner_id"), self.cred_path)
                    await self.send({"type": "publish", "devices": [self.manifest]})
                    if hb is None:
                        hb = asyncio.create_task(self.heartbeat())
                    pending, self.outbox = self.outbox, []
                    for r in pending:
                        await self.send(r)
                elif not welcomed and t != "error":
                    log.warning("ignoring %s before welcome", t)
                elif t == "published":
                    for d in msg.get("devices", []):
                        if d.get("local_key") == self.local_key:
                            self.device_id = d.get("device_id")
                            log.info("published %s as %s (%s)", self.local_key, self.device_id, d.get("status"))
                elif t == "invoke":
                    self.on_invoke(msg)
                elif t == "cancel":
                    self.on_cancel(msg)
                elif t == "revoke":
                    self.on_revoke(msg)
                elif t == "ping":
                    await self.send({"type": "heartbeat", "at": now_iso()})
                elif t == "error":
                    log.error("coordinator error: %s", msg.get("message"))
                    if not welcomed and "credential" in hello:
                        self.cred_rejected = True
                        log.error("stored credential was rejected%s", "; will retry with --pair code"
                                  if self.pair_code else "; re-pair with --pair CODE")
                elif t == "signal":
                    pass  # WebRTC signaling is not used by the Pi connector
                else:
                    log.debug("ignoring unknown message type %s", t)
        finally:
            if hb:
                hb.cancel()
        return welcomed

    async def heartbeat(self) -> None:
        while True:
            await self.send({"type": "heartbeat", "at": now_iso()})
            await asyncio.sleep(HEARTBEAT_S)

    # ---------------- invocations
    async def finish(self, invocation_id: str, state: str, output: dict[str, Any] | None = None,
                     error: str | None = None) -> None:
        r: dict[str, Any] = {"type": "result", "invocation_id": invocation_id, "state": state}
        if output:
            r["output"] = output
        if error:
            r["error"] = error
        self.results[invocation_id] = r
        self.started.discard(invocation_id)
        self.cancelled.discard(invocation_id)
        while len(self.results) > RESULT_CACHE_SIZE:
            self.results.popitem(last=False)
        try:
            write_private(self.results_path, dict(self.results))
        except OSError as e:
            log.warning("cannot persist results cache: %s", e)
        log.info("result %s %s %s", invocation_id, state, error or "")
        if not await self.send(r):
            self.outbox.append(r)

    def validate(self, msg: dict[str, Any]) -> tuple[dict[str, Any], datetime]:
        if msg.get("local_key") != self.local_key:
            raise Rejected(f"unknown local_key {msg.get('local_key')!r}")
        if self.device_id and msg.get("device_id") != self.device_id:
            raise Rejected("device_id does not match this connector's device")
        cid = msg.get("capability_id")
        cap = self.caps.get(cid) if isinstance(cid, str) else None
        if cap is None:
            raise Rejected(f"unknown capability {msg.get('capability_id')!r}")
        args = msg.get("arguments")
        if args is None:
            args = {}
        if not isinstance(args, dict):
            raise Rejected("arguments must be an object")
        extra = set(args) - set(cap["input_schema"].get("properties", {}))
        if extra:
            raise Rejected(f"unexpected arguments: {sorted(extra)}")
        lease = msg.get("lease_id")
        if lease is not None and not isinstance(lease, str):
            raise Rejected("lease_id must be a string or null")
        if lease in self.revoked:
            raise Rejected("lease revoked")
        deadline = parse_iso(msg.get("deadline"))
        if deadline is None:
            raise Rejected("deadline missing or not ISO-8601")
        if deadline <= datetime.now(timezone.utc):
            raise Rejected("deadline already passed")
        if cap["capability_id"] == "camera.snapshot":
            up = msg.get("upload")
            if not (isinstance(up, dict) and isinstance(up.get("url"), str) and isinstance(up.get("token"), str)
                    and urllib.parse.urlsplit(up["url"]).scheme in ("http", "https")):
                raise Rejected("camera.snapshot needs upload {url (http/https), token}")
        return cap, deadline

    def on_invoke(self, msg: dict[str, Any]) -> None:
        inv = msg.get("invocation_id")
        if not isinstance(inv, str) or not inv or len(inv) > 128:
            log.warning("invoke without a valid invocation_id; ignored")
            return
        if inv in self.results:
            log.info("duplicate invoke %s: resending cached result (no new action)", inv)
            asyncio.create_task(self.send(self.results[inv]))
            return
        if inv in self.running:
            log.info("duplicate invoke %s: already running", inv)
            return
        task = asyncio.create_task(self.handle_invoke(inv, msg))
        self.running[inv] = task
        task.add_done_callback(lambda _t: self.running.pop(inv, None))

    async def handle_invoke(self, inv: str, msg: dict[str, Any]) -> None:
        try:
            cap, deadline = self.validate(msg)
        except Rejected as e:
            return await self.finish(inv, "rejected", error=str(e))
        cid = cap["capability_id"]
        try:
            if cid in ("cover.open", "cover.close"):
                await self.do_cover(inv, msg, cid, deadline)
            elif cid == "cover.state":
                await self.finish(inv, "succeeded", {
                    "value": self.cover_state,
                    "data": {"angle": self.angle, "last_commanded_at": self.last_commanded_at,
                             "moving": self.motion_lock.locked()},
                    "note": self.state_note})
            elif cid == "camera.snapshot":
                await self.do_snapshot(inv, msg, deadline)
        except Exception as e:
            log.exception("invocation %s crashed", inv)
            if inv not in self.results:
                await self.finish(inv, "failed", error=f"connector error: {e}")

    async def do_cover(self, inv: str, msg: dict[str, Any], cid: str, deadline: datetime) -> None:
        target = "open" if cid == "cover.open" else "closed"
        angle = self.cfg["servo"]["open_angle" if target == "open" else "close_angle"]
        async with self.motion_lock:
            if inv in self.cancelled:
                return await self.finish(inv, "failed", error="cancelled")
            if msg.get("lease_id") in self.revoked:
                return await self.finish(inv, "rejected", error="lease revoked")
            if deadline <= datetime.now(timezone.utc):
                return await self.finish(inv, "failed", error="deadline passed before the motion started")
            self.started.add(inv)
            ok = await self.move(angle, target, inv)
        cancel_note = " Cancel arrived after the motion started; motions are not interrupted." \
            if inv in self.cancelled else ""
        if not ok:
            return await self.finish(inv, "unknown", error="servo error during motion; position unknown")
        await self.finish(inv, "succeeded", {
            "value": target, "data": {"angle": angle, "commanded_at": self.last_commanded_at},
            "note": "Reported from the commanded servo angle; physical position is not sensed." + cancel_note})

    async def move(self, angle: float, target: str, inv: str | None) -> bool:
        """Caller must hold motion_lock. Writes an in-flight marker around the motion."""
        write_private(self.marker_path, {"invocation_id": inv, "target": target, "angle": angle,
                                         "started_at": now_iso()})
        try:
            await asyncio.to_thread(self.servo.move, angle)
        except Exception:
            log.exception("servo move failed")
            self.cover_state, self.angle = "unknown", None
            self.state_note = "Last motion failed with a servo error; position unknown."
            return False
        finally:
            self.marker_path.unlink(missing_ok=True)
        self.cover_state, self.angle, self.last_commanded_at = target, angle, now_iso()
        self.state_note = "Last commanded state (not sensed)."
        return True

    async def do_snapshot(self, inv: str, msg: dict[str, Any], deadline: datetime) -> None:
        assert self.camera is not None
        async with self.camera_lock:
            if inv in self.cancelled:
                return await self.finish(inv, "failed", error="cancelled")
            self.started.add(inv)
            captured_at = now_iso()
            jpeg = await asyncio.to_thread(self.camera.capture_jpeg)
        remaining = max(1.0, (deadline - datetime.now(timezone.utc)).total_seconds())
        up = msg["upload"]
        try:
            obs = await asyncio.to_thread(upload, up["url"], up["token"], jpeg, "image/jpeg", captured_at, remaining)
        except Exception as e:
            return await self.finish(inv, "failed", error=f"upload failed: {e}")
        await self.finish(inv, "succeeded", {"observation_id": obs, "captured_at": captured_at,
                                             "data": {"bytes": len(jpeg), "simulated": bool(self.args.simulate)}})

    def on_cancel(self, msg: dict[str, Any]) -> None:
        inv = msg.get("invocation_id")
        if not isinstance(inv, str) or inv not in self.running:
            return
        self.cancelled.add(inv)
        if inv in self.started:
            log.info("cancel %s: already in progress; motions complete (cannot be interrupted safely)", inv)
        else:
            log.info("cancel %s: will not start", inv)

    def on_revoke(self, msg: dict[str, Any]) -> None:
        lease = msg.get("lease_id")
        if not isinstance(lease, str):
            return
        self.revoked[lease] = None
        while len(self.revoked) > MAX_REVOKED:
            self.revoked.popitem(last=False)
        ids = msg.get("device_ids") or []
        ours = not ids or (self.device_id in ids)
        log.info("lease %s revoked; further invokes for it are rejected", lease)
        if ours and self.cfg["on_revoke"] == "close":
            asyncio.create_task(self.close_on_revoke(lease))

    async def close_on_revoke(self, lease: str) -> None:
        async with self.motion_lock:
            if self.cover_state == "closed":
                return
            log.info("on_revoke=close: closing cover after lease %s ended", lease)
            await self.move(self.cfg["servo"]["close_angle"], "closed", None)

    async def shutdown(self) -> None:
        if self.motion_lock.locked():
            log.info("waiting for the in-progress motion to complete before exiting...")
        async with self.motion_lock:
            self.servo.close()
            if self.camera:
                self.camera.close()


def upload(url: str, token: str, body: bytes, content_type: str, captured_at: str, timeout: float) -> str:
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Content-Type": content_type, "Authorization": f"Bearer {token}", "X-Captured-At": captured_at,
        "User-Agent": f"ghost-pi/{CONNECTOR_VERSION}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read(65536) or b"{}")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}") from None
    obs = data.get("observation_id")
    if not isinstance(obs, str) or not obs:
        raise RuntimeError("upload response has no observation_id")
    return obs


def to_ws_url(coordinator: str) -> str:
    if "://" not in coordinator:  # bare host: TLS unless it is a local dev host
        local = coordinator.split(":")[0].split("/")[0] in ("localhost", "127.0.0.1")
        coordinator = ("http://" if local else "https://") + coordinator
    u = urllib.parse.urlsplit(coordinator)
    scheme = {"http": "ws", "https": "wss", "ws": "ws", "wss": "wss"}.get(u.scheme)
    if not scheme or not u.netloc:
        raise SystemExit(f"invalid --coordinator URL: {coordinator}")
    path = u.path.rstrip("/")
    if not path.endswith("/v1/device-channel"):
        path += "/v1/device-channel"
    return urllib.parse.urlunsplit((scheme, u.netloc, path, "", ""))


async def amain(args: argparse.Namespace, cfg: dict[str, Any]) -> int:
    conn = Connector(args, cfg)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, conn.stopping.set)
        except NotImplementedError:
            pass
    runner = asyncio.create_task(conn.run())
    await conn.stopping.wait()
    if conn.ws is not None:
        await conn.ws.close()
    try:
        await asyncio.wait_for(runner, timeout=5)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        runner.cancel()
    await conn.shutdown()
    log.info("stopped")
    return conn.exit_code


def main() -> None:
    p = argparse.ArgumentParser(description="GHOST Raspberry Pi connector")
    p.add_argument("--coordinator", required=True, help="coordinator URL, e.g. https://ghost.example")
    p.add_argument("--pair", metavar="CODE", help="one-use pairing code from GHOST (first run only)")
    default_cfg = Path(__file__).with_name("config.toml")
    p.add_argument("--config", type=Path, default=default_cfg if default_cfg.exists() else None)
    p.add_argument("--simulate", action="store_true", help="no GPIO/camera hardware; log motions instead")
    p.add_argument("--state-dir", default="~/.ghost-pi", help="where the credential and markers are stored")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("websockets").setLevel(logging.WARNING)
    cfg = load_config(args.config)
    if not args.simulate:
        try:
            import gpiozero  # noqa: F401
        except ImportError:
            sys.exit("gpiozero is not installed (are you on a Raspberry Pi?). Use --simulate to try without hardware.")
    sys.exit(asyncio.run(amain(args, cfg)))


if __name__ == "__main__":
    main()
