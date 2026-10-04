/**
 * SIMULATED smart-home devices for testing the GHOST LAN drivers. NOT REAL HARDWARE.
 *
 * Every simulated device names itself "SIM …" so it can never be mistaken for a real one.
 * They speak the same documented local APIs as the real devices, on localhost only:
 *
 *   :8081  Shelly Plus Plug S (Gen2 RPC: /shelly, /rpc/Switch.Set, /rpc/Switch.GetStatus …)
 *   :8082  WLED strip         (/json/info, /json/state, /json/eff)
 *   :8083  Philips Hue bridge (/api/config, POST /api pairing, /api/<user>/lights …)
 *            press the simulated link button: curl localhost:8083/sim/linkbutton  (release: /sim/reset)
 *   :8084  Roku               (ECP: /query/device-info, /keypress/<key>, /launch/<id> …)
 *   :9999  TP-Link Kasa plug  (TCP, XOR-autokey protocol, get_sysinfo / set_relay_state / emeter)
 *   :8124  Home Assistant     (REST: /api/states, /api/services/<domain>/<service>, camera proxy) token "sim-token"
 *
 * Run:   pnpm exec tsx scripts/lan-fake-devices.ts
 * Then:  GHOST_LAN_EXTRA_HOSTS="127.0.0.1:8081,127.0.0.1:8082,127.0.0.1:8083,roku@127.0.0.1:8084,kasa@127.0.0.1:9999" \
 *        HA_URL=http://127.0.0.1:8124 HA_TOKEN=sim-token  <coordinator or scripts/lan-test.ts>
 */
import http from "node:http";
import net from "node:net";

const HOST = "127.0.0.1";
const PORTS = {
  shelly: Number(process.env.SIM_SHELLY_PORT ?? 8081),
  wled: Number(process.env.SIM_WLED_PORT ?? 8082),
  hue: Number(process.env.SIM_HUE_PORT ?? 8083),
  roku: Number(process.env.SIM_ROKU_PORT ?? 8084),
  kasa: Number(process.env.SIM_KASA_PORT ?? 9999),
  ha: Number(process.env.SIM_HA_PORT ?? 8124),
};
const quiet = process.argv.includes("--quiet");
const log = (dev: string, msg: string) => !quiet && console.log(`[sim ${dev}] ${msg}`);

type Handler = (req: http.IncomingMessage, url: URL, body: string) => { status?: number; json?: unknown; text?: string; type?: string; bytes?: Buffer } | null;

function serve(name: string, port: number, handler: Handler) {
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", `http://${HOST}:${port}`);
      let out: ReturnType<Handler>;
      try {
        out = handler(req, url, body);
      } catch (e) {
        out = { status: 500, json: { error: (e as Error).message } };
      }
      if (!out) out = { status: 404, text: "not found" };
      log(name, `${req.method} ${url.pathname}${url.search} -> ${out.status ?? 200}`);
      if (out.bytes) {
        res.writeHead(out.status ?? 200, { "content-type": out.type ?? "application/octet-stream" });
        res.end(out.bytes);
      } else if (out.json !== undefined) {
        res.writeHead(out.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(out.json));
      } else {
        res.writeHead(out.status ?? 200, { "content-type": out.type ?? "text/plain" });
        res.end(out.text ?? "");
      }
    });
  });
  srv.on("error", (e) => console.error(`[sim ${name}] cannot listen on ${port}: ${e.message}`));
  srv.listen(port, HOST, () => console.log(`SIM ${name.padEnd(6)} http://${HOST}:${port}`));
  return srv;
}

/* ---------------- Shelly Plus Plug S (Gen2) ---------------- */
const shelly = { on: false };
serve("shelly", PORTS.shelly, (_req, url) => {
  const p = url.pathname;
  const status = () => ({ id: 0, source: "http", output: shelly.on, apower: shelly.on ? 42.5 : 0, voltage: 120.1, current: shelly.on ? 0.354 : 0, aenergy: { total: 1234.5 }, temperature: { tC: 38.2 } });
  const info = { name: "SIM Shelly Plus Plug S", id: "shellyplusplugs-sim000001", mac: "AABBCC000001", model: "SNPL-00116US", gen: 2, fw_id: "sim", ver: "1.4.4-sim", app: "PlusPlugS", auth_en: false, auth_domain: null };
  if (p === "/shelly" || p === "/rpc/Shelly.GetDeviceInfo") return { json: info };
  if (p === "/rpc/Shelly.GetStatus") return { json: { "switch:0": status(), sys: { mac: info.mac } } };
  if (p === "/rpc/Sys.GetConfig") return { json: { device: { name: info.name }, sys: { device: { name: info.name } } } };
  if (p === "/rpc/Switch.GetStatus") return { json: status() };
  if (p === "/rpc/Switch.Set") {
    const was = shelly.on;
    const v = url.searchParams.get("on");
    if (v !== "true" && v !== "false") return { status: 400, json: { code: -103, message: "Invalid argument 'on'" } };
    shelly.on = v === "true";
    return { json: { was_on: was } };
  }
  if (p === "/rpc/Switch.Toggle") {
    const was = shelly.on;
    shelly.on = !shelly.on;
    return { json: { was_on: was } };
  }
  return null;
});

/* ---------------- WLED ---------------- */
const EFFECTS = ["Solid", "Blink", "Breathe", "Wipe", "Wipe Random", "Random Colors", "Sweep", "Dynamic", "Colorloop", "Rainbow", "Scan", "Scan Dual", "Fade", "Theater", "Theater Rainbow", "Running", "Saw", "Twinkle", "Dissolve", "Dissolve Rnd", "Sparkle", "Sparkle Dark", "Sparkle+", "Strobe", "Strobe Rainbow", "Strobe Mega", "Blink Rainbow", "Android", "Chase", "Chase Random", "Chase Rainbow", "Chase Flash", "Chase Flash Rnd", "Rainbow Runner", "Colorful", "Traffic Light", "Sweep Random", "Chase 2", "Aurora", "Stream", "Scanner", "Lighthouse", "Fireworks", "Rain", "Tetrix", "Fire Flicker", "Gradient", "Loading", "Rolling Balls", "Fairy", "Two Dots", "Fairytwinkle", "Running Dual", "Halloween", "Chase 3", "Tri Wipe", "Tri Fade", "Lightning", "ICU", "Multi Comet", "Scanner Dual", "Stream 2", "Oscillate", "Pride 2015", "Juggle", "Palette", "Fire 2012", "Colorwaves", "Bpm", "Fill Noise", "Noise 1", "Noise 2", "Noise 3", "Noise 4", "Colortwinkles", "Lake", "Meteor", "Meteor Smooth", "Railway", "Ripple", "Twinklefox", "Twinklecat", "Halloween Eyes", "Solid Pattern", "Solid Pattern Tri", "Spots", "Spots Fade", "Glitter", "Candle", "Fireworks Starburst", "Fireworks 1D", "Bouncing Balls", "Sinelon", "Sinelon Dual", "Sinelon Rainbow", "Popcorn", "Drip", "Plasma", "Percent", "Ripple Rainbow", "Heartbeat", "Pacifica", "Candle Multi", "Solid Glitter", "Sunrise", "Phased", "Twinkleup", "Noise Pal", "Sine", "Phased Noise", "Flow", "Chunchun", "Dancing Shadows", "Washing Machine"];
const wled = { on: true, bri: 128, seg: [{ id: 0, start: 0, stop: 60, on: true, bri: 255, col: [[255, 160, 0], [0, 0, 0], [0, 0, 0]], fx: 0, sx: 128, ix: 128 }] };
const wledInfo = { ver: "0.15.0-sim", vid: 2410270, leds: { count: 60, rgbw: false, pwr: 0, fps: 42 }, name: "SIM WLED strip", udpport: 21324, live: false, brand: "WLED", product: "FOSS", mac: "aabbcc000002", arch: "esp32", ip: HOST };
serve("wled", PORTS.wled, (req, url, body) => {
  const p = url.pathname;
  if (p === "/json/info") return { json: wledInfo };
  if (p === "/json/eff") return { json: EFFECTS };
  if (p === "/json" || p === "/json/si") return { json: { state: wled, info: wledInfo, effects: EFFECTS } };
  if (p === "/json/state") {
    if (req.method === "POST") {
      const b = JSON.parse(body || "{}") as { on?: boolean | "t"; bri?: number; seg?: { id?: number; col?: number[][]; fx?: number }[] | { col?: number[][]; fx?: number }; v?: boolean };
      if (b.on === "t") wled.on = !wled.on;
      else if (typeof b.on === "boolean") wled.on = b.on;
      if (typeof b.bri === "number") wled.bri = Math.max(0, Math.min(255, b.bri));
      const segs = Array.isArray(b.seg) ? b.seg : b.seg ? [b.seg] : [];
      for (const s of segs) {
        const target = wled.seg.find((x) => x.id === (("id" in s ? s.id : 0) ?? 0)) ?? wled.seg[0];
        if (s.col?.[0]) target.col[0] = s.col[0].slice(0, 3);
        if (typeof s.fx === "number" && s.fx >= 0 && s.fx < EFFECTS.length) target.fx = s.fx;
      }
      return { json: b.v ? wled : { success: true } };
    }
    return { json: wled };
  }
  return null;
});

/* ---------------- Philips Hue bridge ---------------- */
const HUE_USER = "simGHOSTuser0123456789abcdef";
const hue = { linkPressedAt: 0, users: new Set<string>() };
const hueLights: Record<string, { state: { on: boolean; bri: number; hue: number; sat: number; xy: [number, number]; ct: number; colormode: string; reachable: boolean }; type: string; name: string; modelid: string; manufacturername: string; productname: string; uniqueid: string }> = {
  "1": { state: { on: false, bri: 200, hue: 8000, sat: 140, xy: [0.46, 0.41], ct: 366, colormode: "xy", reachable: true }, type: "Extended color light", name: "SIM Hue Living room", modelid: "LCA001", manufacturername: "Signify Netherlands B.V.", productname: "Hue color lamp", uniqueid: "00:17:88:01:00:00:00:01-0b" },
  "2": { state: { on: true, bri: 120, hue: 0, sat: 0, xy: [0.31, 0.32], ct: 300, colormode: "ct", reachable: true }, type: "Color temperature light", name: "SIM Hue Desk", modelid: "LTW001", manufacturername: "Signify Netherlands B.V.", productname: "Hue ambiance lamp", uniqueid: "00:17:88:01:00:00:00:02-0b" },
};
serve("hue", PORTS.hue, (req, url, body) => {
  const p = url.pathname;
  if (p === "/sim/reset") {
    hue.linkPressedAt = 0;
    return { json: { simulated: true, link_button: "released" } };
  }
  if (p === "/sim/linkbutton") {
    hue.linkPressedAt = Date.now();
    return { json: { simulated: true, link_button: "pressed for 30 s" } };
  }
  if (p === "/description.xml") return { type: "text/xml", text: `<root><device><friendlyName>SIM Hue Bridge</friendlyName><manufacturer>Signify</manufacturer><modelName>Philips hue bridge 2015</modelName></device></root>` };
  if (p === "/api/config" || p === "/api/nouser/config")
    return { json: { name: "SIM Hue Bridge", datastoreversion: "166", swversion: "1967054020", apiversion: "1.67.0", mac: "aa:bb:cc:00:00:03", bridgeid: "AABBCCFFFE000003", factorynew: false, replacesbridgeid: null, modelid: "BSB002", starterkitid: "" } };
  if (p === "/api" && req.method === "POST") {
    if (Date.now() - hue.linkPressedAt > 30_000) return { json: [{ error: { type: 101, address: "", description: "link button not pressed" } }] };
    hue.users.add(HUE_USER);
    return { json: [{ success: { username: HUE_USER } }] };
  }
  const m = p.match(/^\/api\/([^/]+)\/lights(?:\/(\w+))?(\/state)?$/);
  if (m) {
    if (!hue.users.has(m[1])) return { json: [{ error: { type: 1, address: p.replace(/^\/api/, ""), description: "unauthorized user" } }] };
    if (!m[2]) return { json: hueLights };
    const l = hueLights[m[2]];
    if (!l) return { json: [{ error: { type: 3, description: `resource, /lights/${m[2]}, not available` } }] };
    if (m[3] && req.method === "PUT") {
      const b = JSON.parse(body || "{}") as { on?: boolean; bri?: number; xy?: [number, number]; ct?: number };
      const out: unknown[] = [];
      if (typeof b.on === "boolean") {
        l.state.on = b.on;
        out.push({ success: { [`/lights/${m[2]}/state/on`]: b.on } });
      }
      if (typeof b.bri === "number") {
        l.state.bri = Math.max(1, Math.min(254, b.bri));
        out.push({ success: { [`/lights/${m[2]}/state/bri`]: l.state.bri } });
      }
      if (b.xy) {
        if (l.type === "Color temperature light") out.push({ error: { type: 6, description: "parameter, xy, not available" } });
        else {
          l.state.xy = b.xy;
          l.state.colormode = "xy";
          out.push({ success: { [`/lights/${m[2]}/state/xy`]: b.xy } });
        }
      }
      return { json: out };
    }
    return { json: l };
  }
  return null;
});

/* ---------------- Roku ---------------- */
const roku = { active: { id: "562859", name: "Home" } as { id: string; name: string }, power: "PowerOn" };
const ROKU_APPS = [
  { id: "12", name: "Netflix" },
  { id: "837", name: "YouTube" },
  { id: "2285", name: "Hulu" },
  { id: "tvinput.hdmi1", name: "HDMI 1" },
];
serve("roku", PORTS.roku, (req, url) => {
  const p = url.pathname;
  if (p === "/query/device-info")
    return {
      type: "text/xml",
      text: `<?xml version="1.0" encoding="UTF-8" ?><device-info><udn>sim-roku</udn><serial-number>SIM0000ROKU1</serial-number><vendor-name>Roku</vendor-name><model-name>Roku Express (SIM)</model-name><model-number>3930X</model-number><wifi-mac>aa:bb:cc:00:00:04</wifi-mac><user-device-name>SIM Roku Living Room</user-device-name><is-tv>false</is-tv><power-mode>${roku.power}</power-mode></device-info>`,
    };
  if (p === "/query/apps") return { type: "text/xml", text: `<apps>${ROKU_APPS.map((a) => `<app id="${a.id}" type="appl" version="1.0">${a.name}</app>`).join("")}</apps>` };
  if (p === "/query/active-app") return { type: "text/xml", text: `<active-app><app id="${roku.active.id}">${roku.active.name}</app></active-app>` };
  if (req.method === "POST" && p.startsWith("/keypress/")) {
    const key = p.slice("/keypress/".length);
    if (key === "Home") roku.active = { id: "562859", name: "Home" };
    if (key === "PowerOff") roku.power = "DisplayOff";
    return { text: "" };
  }
  if (req.method === "POST" && p.startsWith("/launch/")) {
    const app = ROKU_APPS.find((a) => a.id === decodeURIComponent(p.slice("/launch/".length)));
    if (!app) return { status: 404, text: "" };
    setTimeout(() => (roku.active = app), 400);
    return { text: "" };
  }
  return null;
});

/* ---------------- TP-Link Kasa plug (TCP 9999) ---------------- */
function kasaEnc(s: string): Buffer {
  const src = Buffer.from(s);
  const out = Buffer.alloc(src.length + 4);
  out.writeUInt32BE(src.length, 0);
  let k = 171;
  for (let i = 0; i < src.length; i++) k = out[i + 4] = k ^ src[i];
  return out;
}
function kasaDec(b: Buffer): string {
  const out = Buffer.alloc(b.length);
  let k = 171;
  for (let i = 0; i < b.length; i++) {
    out[i] = k ^ b[i];
    k = b[i];
  }
  return out.toString();
}
const kasa = { relay: 0 };
const kasaSysinfo = () => ({
  sw_ver: "1.0.0-sim",
  hw_ver: "1.0",
  model: "HS110(US)",
  deviceId: "SIMKASA0000000000000000000000000000005",
  alias: "SIM Kasa Fan Plug",
  mic_type: "IOT.SMARTPLUGSWITCH",
  feature: "TIM:ENE",
  mac: "AA:BB:CC:00:00:05",
  relay_state: kasa.relay,
  led_off: 0,
  rssi: -50,
});
const kasaSrv = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    if (buf.length < 4) return;
    const len = buf.readUInt32BE(0);
    if (buf.length < 4 + len) return;
    const req = JSON.parse(kasaDec(buf.subarray(4, 4 + len))) as Record<string, Record<string, Record<string, unknown>>>;
    const res: Record<string, unknown> = {};
    if (req.system?.get_sysinfo) res.system = { get_sysinfo: { ...kasaSysinfo(), err_code: 0 } };
    if (req.system?.set_relay_state) {
      kasa.relay = Number((req.system.set_relay_state as { state?: number }).state) ? 1 : 0;
      res.system = { set_relay_state: { err_code: 0 } };
    }
    if (req.emeter?.get_realtime) res.emeter = { get_realtime: { power_mw: kasa.relay ? 38_400 : 0, voltage_mv: 120_300, current_ma: kasa.relay ? 320 : 0, total_wh: 4321, err_code: 0 } };
    log("kasa", `${Object.keys(req).map((k) => `${k}.${Object.keys(req[k] ?? {})[0]}`).join(",")} relay=${kasa.relay}`);
    sock.end(kasaEnc(JSON.stringify(res)));
  });
  sock.on("error", () => {});
});
kasaSrv.on("error", (e) => console.error(`[sim kasa] cannot listen on ${PORTS.kasa}: ${e.message}`));
kasaSrv.listen(PORTS.kasa, HOST, () => console.log(`SIM kasa   tcp://${HOST}:${PORTS.kasa}`));

/* ---------------- Home Assistant ---------------- */
const now = () => new Date().toISOString();
type HaEnt = { entity_id: string; state: string; attributes: Record<string, unknown>; last_changed: string; last_updated: string };
const haStates: Record<string, HaEnt> = {};
const ent = (entity_id: string, state: string, attributes: Record<string, unknown>) => (haStates[entity_id] = { entity_id, state, attributes, last_changed: now(), last_updated: now() });
ent("light.sim_kitchen", "off", { friendly_name: "SIM Kitchen light", supported_color_modes: ["hs", "color_temp"], color_mode: null, min_color_temp_kelvin: 2202, max_color_temp_kelvin: 6535 });
ent("switch.sim_fan_plug", "on", { friendly_name: "SIM Fan plug", device_class: "outlet" });
ent("fan.sim_ceiling", "off", { friendly_name: "SIM Ceiling fan", percentage: 0 });
ent("cover.sim_blinds", "closed", { friendly_name: "SIM Office blinds", device_class: "blind", current_position: 0 });
ent("media_player.sim_speaker", "paused", { friendly_name: "SIM Kitchen speaker", device_class: "speaker", volume_level: 0.3, media_title: "Simulated Song" });
ent("climate.sim_thermostat", "heat", { friendly_name: "SIM Thermostat", current_temperature: 20.5, temperature: 21, min_temp: 7, max_temp: 35, temperature_unit: "°C", hvac_modes: ["off", "heat"] });
ent("sensor.sim_temperature", "22.4", { friendly_name: "SIM Living room temperature", unit_of_measurement: "°C", device_class: "temperature" });
ent("binary_sensor.sim_front_door", "off", { friendly_name: "SIM Front door", device_class: "door" });
ent("camera.sim_porch", "idle", { friendly_name: "SIM Porch camera" });
ent("lock.sim_front", "locked", { friendly_name: "SIM Front lock" });
ent("sensor.sim_text_only", "hello", { friendly_name: "SIM text sensor (should be skipped)" });
const AREAS: Record<string, string> = { "light.sim_kitchen": "Kitchen", "media_player.sim_speaker": "Kitchen", "cover.sim_blinds": "Office" };
// 1x1 grey JPEG
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);
function set(id: string, patch: Partial<HaEnt> & { attributes?: Record<string, unknown> }) {
  const e = haStates[id];
  if (patch.state !== undefined && patch.state !== e.state) e.last_changed = now();
  if (patch.state !== undefined) e.state = patch.state;
  if (patch.attributes) Object.assign(e.attributes, patch.attributes);
  e.last_updated = now();
}
serve("ha", PORTS.ha, (req, url, body) => {
  if (req.headers.authorization !== "Bearer sim-token") return { status: 401, text: "401: Unauthorized" };
  const p = url.pathname;
  if (p === "/api/") return { json: { message: "API running." } };
  if (p === "/api/states") return { json: Object.values(haStates) };
  if (p.startsWith("/api/states/")) {
    const e = haStates[decodeURIComponent(p.slice("/api/states/".length))];
    return e ? { json: e } : { status: 404, json: { message: "Entity not found." } };
  }
  if (p === "/api/template" && req.method === "POST") return { text: Object.keys(haStates).map((id) => `${id}\t${AREAS[id] ?? ""}`).join("\n") };
  if (p.startsWith("/api/camera_proxy/")) return { bytes: JPEG, type: "image/jpeg" };
  const m = p.match(/^\/api\/services\/(\w+)\/(\w+)$/);
  if (m && req.method === "POST") {
    const [, domain, service] = m;
    const data = JSON.parse(body || "{}") as Record<string, unknown>;
    const id = String(data.entity_id);
    if (!haStates[id]) return { status: 400, json: { message: "entity not found" } };
    const delay = (fn: () => void) => setTimeout(fn, 250); // HA applies asynchronously
    if (domain === "light" && service === "turn_on")
      delay(() => {
        const attrs: Record<string, unknown> = {};
        if (Array.isArray(data.rgb_color)) Object.assign(attrs, { rgb_color: data.rgb_color, color_mode: "hs" });
        if (typeof data.brightness_pct === "number") attrs.brightness = Math.round((data.brightness_pct / 100) * 255);
        else if (haStates[id].state === "off") attrs.brightness = 255;
        if (typeof data.color_temp_kelvin === "number") Object.assign(attrs, { color_temp_kelvin: data.color_temp_kelvin, color_mode: "color_temp" });
        set(id, { state: "on", attributes: attrs });
      });
    else if (service === "turn_off") delay(() => set(id, { state: domain === "media_player" ? "off" : "off" }));
    else if (service === "turn_on") delay(() => set(id, { state: "on", attributes: typeof data.percentage === "number" ? { percentage: data.percentage } : {} }));
    else if (domain === "cover") delay(() => set(id, { state: service === "open_cover" ? "opening" : service === "close_cover" ? "closing" : haStates[id].state }));
    else if (domain === "media_player") {
      if (service === "volume_set") delay(() => set(id, { attributes: { volume_level: data.volume_level } }));
      else if (service === "media_play_pause") delay(() => set(id, { state: haStates[id].state === "playing" ? "paused" : "playing" }));
      else if (service === "media_play") delay(() => set(id, { state: "playing" }));
      else if (service === "media_pause") delay(() => set(id, { state: "paused" }));
    } else if (domain === "climate" && service === "set_temperature") delay(() => set(id, { attributes: { temperature: data.temperature } }));
    return { json: [] };
  }
  return null;
});

console.log("\nThese are SIMULATORS (labelled 'SIM …'), not real devices. Ctrl-C to stop.\n");
