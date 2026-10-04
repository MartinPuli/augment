import type { CapabilitySpec } from "../../../../contracts";
import type { AdapterDiscovery } from "../../types";
import { ackObs, candidate, fail, lanManifest, ok, reject, verified } from "../caps";
import { errMsg, HttpError, hostUrl, httpRaw, httpText, normMac, sleep, tryText, xmlTag } from "../net";
import type { HostHint, LanDriver } from "../types";

/** Roku External Control Protocol (ECP): https://developer.roku.com/docs/developer-program/dev-tools/external-control-api.md */

export const ROKU_PORT = 8060;
export const ROKU_KEYS = ["Home", "Play", "Select", "Up", "Down", "Left", "Right", "Back", "VolumeUp", "VolumeDown", "VolumeMute", "PowerOff"] as const;

function parseApps(xml: string): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  const re = /<app\s+id="([^"]+)"[^>]*>([^<]*)<\/app>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push({ id: m[1], name: m[2].trim() });
  return out;
}

function caps(apps: { id: string; name: string }[]): CapabilitySpec[] {
  const listed = apps
    .slice(0, 20)
    .map((a) => `${a.name}=${a.id}`)
    .join(", ");
  return [
    {
      capability_id: "media.keypress",
      kind: "act",
      semantic_type: "media.keypress",
      title: "Press a remote button",
      description: "Press one button on the Roku remote.",
      input_schema: { type: "object", properties: { key: { type: "string", enum: [...ROKU_KEYS] } }, required: ["key"], additionalProperties: false },
      verification: "acknowledgment",
      limits: { rate_per_min: 60 },
      estimated_ms: 400,
    },
    {
      capability_id: "media.launch",
      kind: "act",
      semantic_type: "media.launch",
      title: "Launch an app",
      description: `Open an installed channel/app by id.${listed ? ` Installed: ${listed}.` : ""}`.slice(0, 1800),
      input_schema: { type: "object", properties: { app_id: { type: "string", pattern: "^[A-Za-z0-9._-]{1,64}$" } }, required: ["app_id"], additionalProperties: false },
      verification: "reported_state",
      limits: { rate_per_min: 20 },
      estimated_ms: 3000,
    },
    {
      capability_id: "media.read",
      kind: "observe",
      semantic_type: "media.read",
      title: "What's playing",
      description: "Read the app currently in the foreground and the power mode.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      verification: "observation",
      exclusive: false,
      estimated_ms: 500,
    },
  ];
}

export async function fingerprintRoku(host: HostHint): Promise<AdapterDiscovery[] | null> {
  const port = host.port && host.port !== 80 ? host.port : ROKU_PORT;
  const info = await tryText(hostUrl(host.ip, port, "/query/device-info"));
  if (!info || !/<device-info>/i.test(info)) return null;
  const serial = xmlTag(info, "serial-number");
  const name = xmlTag(info, "user-device-name") || xmlTag(info, "friendly-device-name") || xmlTag(info, "default-device-name") || "Roku";
  const model = [xmlTag(info, "model-name"), xmlTag(info, "model-number")].filter(Boolean).join(" ");
  const isTv = xmlTag(info, "is-tv") === "true";
  const vendor = xmlTag(info, "vendor-name") || "Roku";
  const appsXml = await tryText(hostUrl(host.ip, port, "/query/apps"));
  const apps = appsXml ? parseApps(appsXml) : [];
  const meta = {
    driver: "roku" as const,
    support: "supported" as const,
    ip: host.ip,
    port,
    serial,
    mac: normMac(xmlTag(info, "wifi-mac") ?? xmlTag(info, "ethernet-mac")),
    is_tv: isTv,
    discovered_via: [...host.via],
  };
  // ECP can be disabled ("Control by mobile apps"); detect that early.
  if (xmlTag(info, "ecp-setting-mode") === "disabled") {
    return [
      candidate({
        local_key: `roku:${serial ?? host.key}`,
        name,
        device_class: isTv ? "display" : "media",
        vendor,
        model,
        icon: "tv",
        meta: { ...meta, support: "needs_pairing", reason: "Roku network control is disabled.", instructions: "On the Roku: Settings > System > Advanced system settings > Control by mobile apps > Network access: Default/Permissive." },
      }),
    ];
  }
  return [verified(lanManifest({ local_key: `roku:${serial ?? host.key}`, name, device_class: isTv ? "display" : "media", vendor, model, icon: "tv", capabilities: caps(apps), meta }))];
}

async function activeApp(ip: string, port: number, signal?: AbortSignal) {
  const xml = await httpText(hostUrl(ip, port, "/query/active-app"), { signal });
  const m = xml.match(/<app(?:\s+id="([^"]*)")?[^>]*>([^<]*)<\/app>/i);
  return { id: m?.[1] ?? null, name: m?.[2]?.trim() || null };
}

export const rokuDriver: LanDriver = {
  id: "roku",
  async invoke(device, meta, capability_id, args, ctx) {
    const ip = String(meta.ip);
    const port = Number(meta.port ?? ROKU_PORT);
    const post = async (path: string) => {
      const r = await httpRaw(hostUrl(ip, port, path), { method: "POST", body: "", signal: ctx.signal, timeoutMs: 3000 });
      if (r.status === 403) throw new HttpError(403, "the Roku refused the command (Settings > System > Advanced > Control by mobile apps is limited/disabled)");
      if (!r.ok) throw new HttpError(r.status, `HTTP ${r.status}`);
    };
    try {
      switch (capability_id) {
        case "media.keypress": {
          const key = ROKU_KEYS.find((k) => k.toLowerCase() === String(args.key ?? "").toLowerCase());
          if (!key) return reject(`key must be one of ${ROKU_KEYS.join(", ")}`);
          await post(`/keypress/${key}`);
          return ok(ackObs({ key }, `The Roku acknowledged the ${key} key press; the screen was not observed.`));
        }
        case "media.launch": {
          const appId = String(args.app_id ?? "");
          if (!/^[A-Za-z0-9._-]{1,64}$/.test(appId)) return reject("app_id must be an installed app id (see the capability description)");
          await post(`/launch/${encodeURIComponent(appId)}`);
          let cur: { id: string | null; name: string | null } = { id: null, name: null };
          for (let i = 0; i < 4; i++) {
            await sleep(900);
            cur = await activeApp(ip, port, ctx.signal).catch(() => cur);
            if (cur.id === appId) break;
          }
          const data = { requested_app_id: appId, active_app_id: cur.id, active_app: cur.name };
          if (cur.id === appId) return ok({ kind: "state", value: cur.name, data, captured_at: new Date().toISOString(), note: "Active app read back from the Roku." });
          return ok({ ...ackObs(data, `The Roku accepted the launch, but the foreground app is still ${cur.name ?? "unknown"} (apps can take a few seconds to start).`) });
        }
        case "media.read": {
          const cur = await activeApp(ip, port, ctx.signal);
          const info = await httpText(hostUrl(ip, port, "/query/device-info"), { signal: ctx.signal }).catch(() => "");
          return ok({
            kind: "state",
            value: cur.name,
            data: { active_app: cur.name, active_app_id: cur.id, power_mode: xmlTag(info, "power-mode") ?? null },
            captured_at: new Date().toISOString(),
            source: { name: device.name },
          });
        }
        default:
          return reject(`unknown capability ${capability_id}`);
      }
    } catch (e) {
      return fail(`Roku at ${ip} did not respond: ${errMsg(e)}`);
    }
  },
  async probe(meta) {
    const r = await tryText(hostUrl(String(meta.ip), Number(meta.port ?? ROKU_PORT), "/query/device-info"));
    return r ? { online: true } : { online: false, detail: "no answer on :8060/query/device-info" };
  },
};
