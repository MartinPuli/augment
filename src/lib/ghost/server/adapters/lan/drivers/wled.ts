import type { CapabilitySpec } from "../../../../contracts";
import type { AdapterDiscovery } from "../../types";
import { capLightRead, capLightSet, colorClose, fail, lanManifest, ok, parseLightArgs, reject, stateObs, toHex, verified } from "../caps";
import { errMsg, hostUrl, httpJson, normMac, tryJson } from "../net";
import type { HostHint, LanDriver, LanMeta } from "../types";

/** WLED — documented JSON API: https://kno.wled.ge/interfaces/json-api/ */

type WledInfo = { ver?: string; name?: string; mac?: string; brand?: string; product?: string; arch?: string; leds?: { count?: number; rgbw?: boolean } };
type WledSeg = { id?: number; on?: boolean; col?: number[][]; fx?: number; bri?: number };
type WledState = { on?: boolean; bri?: number; seg?: WledSeg[] };

function capEffect(examples: string[]): CapabilitySpec {
  return {
    capability_id: "light.effect",
    kind: "act",
    semantic_type: "light.effect",
    title: "Play an effect",
    description: `Start a built-in WLED animation by name${examples.length ? `, e.g. ${examples.map((e) => `"${e}"`).join(", ")}` : ""}. Use "Solid" to stop animating.`,
    input_schema: {
      type: "object",
      properties: { effect: { type: "string", description: "Effect name (case-insensitive)" } },
      required: ["effect"],
      additionalProperties: false,
    },
    verification: "reported_state",
    limits: { rate_per_min: 60 },
    estimated_ms: 800,
  };
}

export async function fingerprintWled(host: HostHint): Promise<AdapterDiscovery[] | null> {
  const info = await tryJson<WledInfo>(hostUrl(host.ip, host.port, "/json/info"));
  if (!info || typeof info !== "object" || !(info.brand === "WLED" || (info.ver && info.leds))) return null;
  const effects = (await tryJson<string[]>(hostUrl(host.ip, host.port, "/json/eff"))) ?? [];
  const mac = normMac(info.mac);
  const preferred = ["Rainbow", "Breathe", "Fire 2012", "Colorloop", "Candle", "Police", "Twinkle", "Chase"];
  const examples = preferred.filter((p) => effects.includes(p)).slice(0, 6);
  const meta: LanMeta = {
    driver: "wled",
    support: "supported",
    ip: host.ip,
    port: host.port,
    mac,
    led_count: info.leds?.count,
    effect_count: effects.length,
    firmware: info.ver,
    discovered_via: [...host.via],
  };
  return [
    verified(
      lanManifest({
        local_key: `wled:${mac ?? host.key}`,
        name: info.name || "WLED light",
        device_class: "light",
        vendor: "WLED",
        model: [info.arch?.toUpperCase(), info.leds?.count ? `${info.leds.count} LEDs` : null].filter(Boolean).join(" · ") || undefined,
        icon: "lightbulb",
        capabilities: [capLightSet({ color: true }), ...(effects.length ? [capEffect(examples)] : []), capLightRead()],
        meta,
      }),
    ),
  ];
}

function describe(st: WledState, effects?: string[]) {
  const seg = st.seg?.[0];
  const col = seg?.col?.[0];
  return {
    on: !!st.on,
    brightness: typeof st.bri === "number" ? Math.round((st.bri / 255) * 100) : undefined,
    color: col && col.length >= 3 ? toHex(col) : undefined,
    effect: effects && typeof seg?.fx === "number" ? effects[seg.fx] : seg?.fx,
    segments: st.seg?.length ?? 0,
  };
}

export const wledDriver: LanDriver = {
  id: "wled",
  async invoke(device, meta, capability_id, args, ctx) {
    const ip = String(meta.ip);
    const port = meta.port as number | undefined;
    const url = (p: string) => hostUrl(ip, port, p);
    try {
      switch (capability_id) {
        case "light.set": {
          const p = parseLightArgs(args, { color: true });
          if (!p.ok) return reject(p.error);
          const a = p.value;
          const cur = await httpJson<WledState>(url("/json/state"), { signal: ctx.signal });
          const segIds = (cur.seg ?? []).map((s, i) => s.id ?? i);
          const body: Record<string, unknown> = { v: true };
          if (a.on !== undefined) body.on = a.on;
          if (a.brightness !== undefined) {
            if (a.brightness === 0) body.on = false;
            else {
              body.bri = Math.max(1, Math.round(a.brightness * 2.55));
              if (a.on === undefined) body.on = true;
            }
          }
          if (a.color) {
            body.seg = (segIds.length ? segIds : [0]).map((id) => ({ id, col: [[...a.color!]], fx: 0 }));
            if (a.on === undefined && body.on === undefined) body.on = true;
          }
          await httpJson(url("/json/state"), { method: "POST", body, signal: ctx.signal, timeoutMs: 2500 });
          const after = await httpJson<WledState>(url("/json/state"), { signal: ctx.signal });
          const d = describe(after);
          const obs = stateObs(d, { value: d.on, name: device.name, note: "State read back from WLED after the command." });
          const wantOn = body.on as boolean | undefined;
          if (wantOn !== undefined && d.on !== wantOn) return { state: "failed", error: `WLED reports on=${d.on} after the command`, observation: obs };
          const col = after.seg?.[0]?.col?.[0];
          if (a.color && col && !colorClose(a.color, [col[0], col[1], col[2]], 8))
            return { state: "failed", error: `WLED reports color ${d.color} instead of ${toHex(a.color)}`, observation: obs };
          return ok(obs);
        }
        case "light.effect": {
          const name = typeof args.effect === "string" ? args.effect.trim() : typeof args.effect === "number" ? String(args.effect) : "";
          if (!name) return reject("effect (string) is required");
          const effects = await httpJson<string[]>(url("/json/eff"), { signal: ctx.signal });
          const lower = name.toLowerCase();
          let idx = effects.findIndex((e) => e.toLowerCase() === lower);
          if (idx < 0) idx = effects.findIndex((e) => e.toLowerCase().includes(lower));
          if (idx < 0 && /^\d+$/.test(name) && Number(name) < effects.length) idx = Number(name);
          if (idx < 0) return reject(`unknown effect "${name}". Some available: ${effects.slice(0, 25).join(", ")}`);
          const cur = await httpJson<WledState>(url("/json/state"), { signal: ctx.signal });
          const segIds = (cur.seg ?? []).map((s, i) => s.id ?? i);
          await httpJson(url("/json/state"), {
            method: "POST",
            body: { on: true, v: true, seg: (segIds.length ? segIds : [0]).map((id) => ({ id, fx: idx })) },
            signal: ctx.signal,
            timeoutMs: 2500,
          });
          const after = await httpJson<WledState>(url("/json/state"), { signal: ctx.signal });
          const d = describe(after, effects);
          const obs = stateObs(d, { value: String(d.effect ?? ""), name: device.name, note: "Effect read back from WLED." });
          if (after.seg?.[0]?.fx !== idx) return { state: "failed", error: `WLED reports effect ${d.effect} instead of ${effects[idx]}`, observation: obs };
          return ok(obs);
        }
        case "light.read": {
          const [st, effects] = await Promise.all([
            httpJson<WledState>(url("/json/state"), { signal: ctx.signal }),
            httpJson<string[]>(url("/json/eff"), { signal: ctx.signal }).catch(() => undefined),
          ]);
          const d = describe(st, effects);
          return ok(stateObs(d, { value: d.on, name: device.name }));
        }
        default:
          return reject(`unknown capability ${capability_id}`);
      }
    } catch (e) {
      return fail(`WLED at ${ip} did not respond: ${errMsg(e)}`);
    }
  },
  async probe(meta) {
    const r = await tryJson(hostUrl(String(meta.ip), meta.port as number | undefined, "/json/info"));
    return r ? { online: true } : { online: false, detail: "no answer on /json/info" };
  },
};
