/**
 * SIMULATED GHOST connector (explicitly labeled: no real hardware is involved).
 *
 * Connects OUTBOUND to the coordinator device channel, publishes a "Simulated lamp" (light.set) and a
 * "Simulated camera" (camera.snapshot, uploads a generated PNG), sends heartbeats every 5s and answers
 * invocations. Used by scripts/coord-smoke.ts and handy for demos without hardware.
 *
 * CLI:
 *   pnpm tsx scripts/coord-fake-connector.ts [--url http://localhost:3000] [--owner-token gho_...] [--pairing-code ABC123]
 *   (without a token it creates a fresh principal via GET /api/v1/me and prints its owner token)
 */
import { deflateSync } from "node:zlib";
import WebSocket from "ws";
import type { CoordinatorMessage, DeviceManifest } from "../src/lib/ghost/contracts";
import { PROTOCOL_VERSION } from "../src/lib/ghost/contracts";

/* ---------------- tiny PNG encoder (no deps) ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Generate a small RGB PNG: a gradient "scene" whose hue depends on the lamp state and time. */
export function makePng(width = 160, height = 120, seed = Date.now(), lampOn = false): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  const phase = (seed / 1000) % 360;
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      const glow = lampOn ? Math.max(0, 1 - Math.hypot(x - width / 2, y - height / 3) / 60) : 0;
      raw[o] = Math.min(255, Math.round(20 + (x / width) * 60 + glow * 235));
      raw[o + 1] = Math.min(255, Math.round(22 + (y / height) * 50 + glow * 200 + (phase % 30)));
      raw[o + 2] = Math.min(255, Math.round(30 + ((x + y) / (width + height)) * 80 + glow * 120));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------------- manifests ---------------- */

export function simulatedManifests(opts: { lampPrice?: number; lampFloor?: number; cameraPrice?: number; quota?: number } = {}): DeviceManifest[] {
  return [
    {
      protocol_version: PROTOCOL_VERSION,
      local_key: "sim-lamp",
      name: "Simulated lamp",
      device_class: "light",
      transport: "other",
      vendor: "GHOST simulator",
      model: "SIMULATED — no real hardware",
      zone_id: "sim-desk",
      location: { lat: 37.7749, lon: -122.4194, label: "Simulator (San Francisco)" },
      access_type: "owner_shared",
      terms: {
        price_cents: opts.lampPrice ?? 50,
        floor_cents: opts.lampFloor ?? 20,
        currency: "USD",
        max_duration_s: 300,
        quota: opts.quota ?? 6,
        note: "Simulated device for testing. Test funds only.",
      },
      capabilities: [
        {
          capability_id: "light.set",
          kind: "act",
          semantic_type: "light.set",
          title: "Turn the simulated lamp on/off",
          description: "SIMULATED: sets the on/off state and brightness of a simulated lamp; reports the resulting state.",
          input_schema: {
            type: "object",
            properties: {
              on: { type: "boolean" },
              brightness: { type: "integer", minimum: 0, maximum: 100 },
              color: { type: "string", enum: ["warm", "cool", "red", "green", "blue"] },
            },
            required: ["on"],
            additionalProperties: false,
          },
          verification: "reported_state",
          affects_view_of: "sim-camera",
          estimated_ms: 100,
        },
      ],
      icon: "lightbulb",
    },
    {
      protocol_version: PROTOCOL_VERSION,
      local_key: "sim-camera",
      name: "Simulated camera",
      device_class: "camera",
      transport: "other",
      vendor: "GHOST simulator",
      model: "SIMULATED — generated images",
      zone_id: "sim-desk",
      location: { lat: 37.7749, lon: -122.4194, label: "Simulator (San Francisco)" },
      access_type: "owner_shared",
      terms: { price_cents: opts.cameraPrice ?? 25, floor_cents: 10, currency: "USD", max_duration_s: 300, note: "Simulated camera. Images are generated, not captured." },
      capabilities: [
        {
          capability_id: "camera.snapshot",
          kind: "observe",
          semantic_type: "image.observe",
          title: "Take a simulated snapshot",
          description: "SIMULATED: returns a generated PNG of the simulated desk (brighter when the simulated lamp is on).",
          input_schema: { type: "object", properties: {}, additionalProperties: false },
          output: { media: "image/png" },
          verification: "observation",
          estimated_ms: 200,
        },
      ],
      icon: "camera",
    },
  ];
}

/* ---------------- connector ---------------- */

export interface FakeConnectorOptions {
  /** Coordinator origin, e.g. http://localhost:3100 */
  url: string;
  owner_token?: string;
  credential?: string;
  pairing_code?: string;
  label?: string;
  manifests?: DeviceManifest[];
  /** capability ids this simulator deliberately never answers (exercises the timeout -> unknown path) */
  hang?: string[];
  heartbeatMs?: number;
  log?: (m: string) => void;
}

export interface FakeConnector {
  ws: WebSocket;
  received: CoordinatorMessage[];
  welcome: Promise<Extract<CoordinatorMessage, { type: "welcome" }>>;
  published: Promise<Extract<CoordinatorMessage, { type: "published" }>>;
  waitFor: <T extends CoordinatorMessage["type"]>(type: T, timeoutMs?: number) => Promise<Extract<CoordinatorMessage, { type: T }>>;
  lamp: { on: boolean; brightness: number; color: string };
  close: () => void;
}

export function startFakeConnector(opts: FakeConnectorOptions): FakeConnector {
  const log = opts.log ?? ((m: string) => console.log(`[sim-connector] ${m}`));
  const wsUrl = opts.url.replace(/^http/, "ws").replace(/\/$/, "") + "/v1/device-channel";
  const ws = new WebSocket(wsUrl);
  const received: CoordinatorMessage[] = [];
  const listeners = new Set<(m: CoordinatorMessage) => void>();
  const lamp = { on: false, brightness: 0, color: "warm" };
  let hb: ReturnType<typeof setInterval> | null = null;

  const waitFor = <T extends CoordinatorMessage["type"]>(type: T, timeoutMs = 5000) =>
    new Promise<Extract<CoordinatorMessage, { type: T }>>((resolve, reject) => {
      const t = setTimeout(() => {
        listeners.delete(fn);
        reject(new Error(`timeout waiting for ${type}`));
      }, timeoutMs);
      const fn = (m: CoordinatorMessage) => {
        if (m.type === type) {
          clearTimeout(t);
          listeners.delete(fn);
          resolve(m as Extract<CoordinatorMessage, { type: T }>);
        }
      };
      listeners.add(fn);
    });

  const welcome = waitFor("welcome", 15000);
  const published = waitFor("published", 15000);
  welcome.catch(() => {});
  published.catch(() => {});
  const send = (m: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

  ws.on("open", () => {
    send({
      type: "hello",
      protocol_version: PROTOCOL_VERSION,
      connector_kind: "other",
      label: opts.label ?? "Simulated connector (no real hardware)",
      ...(opts.credential ? { credential: opts.credential } : {}),
      ...(opts.owner_token ? { owner_token: opts.owner_token } : {}),
      ...(opts.pairing_code ? { pairing_code: opts.pairing_code } : {}),
      nonce: Math.random().toString(36).slice(2),
    });
  });

  ws.on("message", async (raw) => {
    let m: CoordinatorMessage;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    received.push(m);
    for (const fn of [...listeners]) fn(m);
    switch (m.type) {
      case "welcome":
        log(`welcome: connector ${m.connector_id} (owner ${m.owner_id})`);
        send({ type: "publish", devices: opts.manifests ?? simulatedManifests() });
        hb = setInterval(() => send({ type: "heartbeat", at: new Date().toISOString() }), opts.heartbeatMs ?? 5000);
        break;
      case "pending_confirmation":
        log(`pending owner confirmation (pairing ${m.pairing_id})`);
        break;
      case "published":
        log(`published ${m.devices.map((d) => `${d.local_key}=${d.device_id}`).join(", ")}`);
        break;
      case "invoke": {
        if (opts.hang?.includes(m.capability_id)) {
          log(`invoke ${m.capability_id}: SIMULATED hang (never answering)`);
          return;
        }
        try {
          if (m.capability_id === "light.set") {
            const a = m.arguments as { on: boolean; brightness?: number; color?: string };
            lamp.on = !!a.on;
            lamp.brightness = a.on ? (a.brightness ?? 100) : 0;
            if (a.color) lamp.color = a.color;
            send({
              type: "result",
              invocation_id: m.invocation_id,
              state: "succeeded",
              output: { data: { ...lamp }, captured_at: new Date().toISOString(), note: "SIMULATED lamp state (no real hardware)" },
            });
          } else if (m.capability_id === "camera.snapshot") {
            const png = makePng(160, 120, Date.now(), lamp.on);
            const captured = new Date().toISOString();
            const r = await fetch(m.upload.url, {
              method: "POST",
              headers: { authorization: `Bearer ${m.upload.token}`, "content-type": "image/png", "x-captured-at": captured },
              body: new Uint8Array(png),
            });
            const j = (await r.json()) as { observation_id?: string; error?: string };
            if (!r.ok || !j.observation_id) throw new Error(`upload failed: ${r.status} ${j.error ?? ""}`);
            send({
              type: "result",
              invocation_id: m.invocation_id,
              state: "succeeded",
              output: { observation_id: j.observation_id, captured_at: captured, note: "SIMULATED camera: generated image" },
            });
          } else {
            send({ type: "result", invocation_id: m.invocation_id, state: "rejected", error: `simulator does not implement ${m.capability_id}` });
          }
        } catch (e) {
          send({ type: "result", invocation_id: m.invocation_id, state: "failed", error: (e as Error).message });
        }
        break;
      }
      case "revoke":
        log(`revoke lease ${m.lease_id} for ${m.device_ids.join(", ")} — stopping`);
        lamp.on = false;
        break;
      case "signal":
        // Simulated WebRTC peer: answer every offer with a fake SDP answer (labeled).
        send({ type: "signal", session_id: m.session_id, to: "viewer", data: { type: "answer", sdp: "SIMULATED-SDP-ANSWER", echo: m.data } });
        break;
      case "error":
        log(`coordinator error: ${m.message}`);
        break;
      default:
        break;
    }
  });
  ws.on("close", () => {
    if (hb) clearInterval(hb);
  });
  ws.on("error", (e) => log(`socket error: ${e.message}`));

  return {
    ws,
    received,
    welcome,
    published,
    waitFor,
    lamp,
    close: () => {
      if (hb) clearInterval(hb);
      ws.close();
    },
  };
}

/* ---------------- CLI ---------------- */

async function cli() {
  const argv = process.argv.slice(2);
  const arg = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const url = arg("--url") ?? `http://localhost:${process.env.PORT || 3000}`;
  let owner_token = arg("--owner-token");
  const pairing_code = arg("--pairing-code");
  const credential = arg("--credential");
  if (!owner_token && !pairing_code && !credential) {
    const r = await fetch(`${url}/api/v1/me`);
    const me = (await r.json()) as { principal_id: string; owner_token: string; display_name: string };
    owner_token = me.owner_token;
    console.log(`[sim-connector] created principal ${me.display_name} (${me.principal_id})`);
    console.log(`[sim-connector] owner token: ${me.owner_token}`);
  }
  console.log("[sim-connector] SIMULATED connector — no real hardware is controlled.");
  const c = startFakeConnector({ url, owner_token, pairing_code, credential });
  c.welcome.then((w) => console.log(`[sim-connector] credential (reuse with --credential): ${w.credential}`)).catch(() => {});
  process.on("SIGINT", () => {
    c.close();
    process.exit(0);
  });
}

const isMain = process.argv[1] && /coord-fake-connector\.ts$/.test(process.argv[1]);
if (isMain) void cli();
