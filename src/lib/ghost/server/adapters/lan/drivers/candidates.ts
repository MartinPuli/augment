import type { DeviceClass } from "../../../../contracts";
import type { AdapterDiscovery } from "../../types";
import { candidate } from "../caps";
import { haConfig } from "./homeassistant";
import type { HostHint, LanSupport } from "../types";

/**
 * Devices we can see but not drive. Published as `candidate` with an honest reason so the agent
 * can explain what it found instead of pretending it can control it.
 */

// HomeKit Accessory Category Identifiers (HAP spec, "ci" TXT record).
const HAP_CATEGORY: Record<string, [DeviceClass, string, string]> = {
  "2": ["hub", "router", "HomeKit bridge"],
  "5": ["light", "lightbulb", "HomeKit light"],
  "7": ["plug", "plug", "HomeKit outlet"],
  "8": ["switch", "toggle-right", "HomeKit switch"],
  "9": ["actuator", "thermometer", "HomeKit thermostat"],
  "10": ["sensor", "activity", "HomeKit sensor"],
  "17": ["camera", "camera", "HomeKit camera"],
  "3": ["actuator", "fan", "HomeKit fan"],
  "6": ["actuator", "lock", "HomeKit lock"],
  "14": ["actuator", "blinds", "HomeKit window covering"],
  "31": ["display", "tv", "HomeKit TV"],
};

interface Classified {
  priority: number;
  name: string;
  device_class: DeviceClass;
  icon: string;
  vendor?: string;
  model?: string;
  support: LanSupport;
  reason: string;
  instructions?: string;
  kind: string;
}

function txt(t: Record<string, unknown> | undefined, k: string): string | undefined {
  const v = t?.[k];
  return typeof v === "string" && v ? v : undefined;
}

function cleanName(n: string): string {
  // DNS-SD instance names often carry a MAC suffix or "@" prefix (AirPlay "AABBCC@Name").
  return n.replace(/^[0-9A-F]{12}@/i, "").replace(/\._.*$/, "").slice(0, 80);
}

/** Apple computers / phones / tablets advertise AirPlay too: those are people's personal devices. */
const PERSONAL_MODEL = /^(Mac\d|MacBook|MacBookPro|MacBookAir|Macmini|iMac|MacPro|iPhone|iPad|iPod|Watch)/i;
const PERSONAL_NAME = /\b(MacBook|iMac|Mac mini|Mac Studio|iPhone|iPad)\b/i;

/**
 * Classify a host GHOST cannot drive. Returns "personal" for computers/phones (never published:
 * on shared Wi-Fi they belong to other people), null if there is nothing worth listing.
 */
export function classifyCandidate(host: HostHint): AdapterDiscovery | "personal" | null {
  const airplay = host.mdns.filter((m) => m.type === "airplay");
  if (
    airplay.length &&
    airplay.every((m) => PERSONAL_MODEL.test(txt(m.txt, "model") ?? "") || (!txt(m.txt, "model") && PERSONAL_NAME.test(m.name))) &&
    host.mdns.every((m) => m.type === "airplay" || m.type === "http")
  )
    return "personal";
  const options: Classified[] = [];
  for (const m of host.mdns) {
    switch (m.type) {
      case "hap": {
        const ci = txt(m.txt, "ci") ?? "";
        const [dc, icon, label] = HAP_CATEGORY[ci] ?? (["other", "house", "HomeKit accessory"] as [DeviceClass, string, string]);
        options.push({
          priority: 3,
          name: cleanName(m.name),
          device_class: dc,
          icon,
          model: txt(m.txt, "md") ?? label,
          support: "unsupported",
          reason: "HomeKit accessories need HomeKit pairing (setup code + encrypted HAP session); not supported by GHOST v0.1.",
          instructions: "If it is also in Home Assistant, set HA_URL/HA_TOKEN and GHOST will import it from there.",
          kind: "homekit",
        });
        break;
      }
      case "googlecast":
        options.push({
          priority: 2,
          name: txt(m.txt, "fn") ?? cleanName(m.name),
          device_class: "media",
          icon: "cast",
          vendor: "Google Cast",
          model: txt(m.txt, "md"),
          support: "unsupported",
          reason: "Google Cast uses a TLS + protobuf session protocol; casting is not supported by GHOST v0.1.",
          kind: "cast",
        });
        break;
      case "ipp":
      case "printer":
        options.push({
          priority: 4,
          name: txt(m.txt, "ty") ?? cleanName(m.name),
          device_class: "printer",
          icon: "printer",
          model: txt(m.txt, "ty"),
          support: "unsupported",
          reason: "Printers are listed for awareness; GHOST v0.1 does not submit print jobs.",
          kind: "printer",
        });
        break;
      case "airplay":
        options.push({
          priority: 2,
          name: cleanName(m.name),
          device_class: "media",
          icon: "airplay",
          vendor: "AirPlay",
          model: txt(m.txt, "model"),
          support: "unsupported",
          reason: "AirPlay receivers require Apple pairing; not supported by GHOST v0.1.",
          kind: "airplay",
        });
        break;
      case "sonos":
        options.push({
          priority: 1,
          name: cleanName(m.name),
          device_class: "speaker",
          icon: "speaker",
          vendor: "Sonos",
          support: "unsupported",
          reason: "Sonos local (UPnP) control is not implemented in GHOST v0.1.",
          instructions: "Add the speaker to Home Assistant and set HA_URL/HA_TOKEN to control it through GHOST.",
          kind: "sonos",
        });
        break;
      case "home-assistant": {
        const base = txt(m.txt, "base_url") ?? txt(m.txt, "internal_url") ?? `http://${host.ip}:${m.port}`;
        options.push({
          priority: 0,
          name: txt(m.txt, "location_name") ? `Home Assistant · ${txt(m.txt, "location_name")}` : "Home Assistant",
          device_class: "hub",
          icon: "house",
          vendor: "Home Assistant",
          model: txt(m.txt, "version") ? `HA ${txt(m.txt, "version")}` : undefined,
          support: haConfig() ? "supported" : "needs_pairing",
          reason: haConfig()
            ? "Home Assistant is configured; its entities are imported as separate devices."
            : "Home Assistant found, but GHOST has no access token for it.",
          instructions: `Create a long-lived access token in your HA profile, then start GHOST with HA_URL=${base} HA_TOKEN=<token> and scan again.`,
          kind: "home-assistant",
        });
        break;
      }
      case "esphomelib":
        options.push({
          priority: 1,
          name: txt(m.txt, "friendly_name") ?? cleanName(m.name),
          device_class: "other",
          icon: "cpu",
          vendor: "ESPHome",
          model: txt(m.txt, "board") ?? txt(m.txt, "platform"),
          support: "unsupported",
          reason: "ESPHome's native API (protobuf on TCP 6053, often encrypted) is not supported by GHOST v0.1.",
          instructions: "Adopt it in Home Assistant and set HA_URL/HA_TOKEN; GHOST will import its entities.",
          kind: "esphome",
        });
        break;
    }
  }
  for (const s of host.ssdp) {
    const server = `${s.server ?? ""} ${s.manufacturer ?? ""}`;
    if (/sonos/i.test(server)) {
      options.push({
        priority: 1,
        name: s.friendlyName ?? "Sonos speaker",
        device_class: "speaker",
        icon: "speaker",
        vendor: "Sonos",
        model: s.modelName,
        support: "unsupported",
        reason: "Sonos local (UPnP) control is not implemented in GHOST v0.1.",
        instructions: "Add the speaker to Home Assistant and set HA_URL/HA_TOKEN to control it through GHOST.",
        kind: "sonos",
      });
    } else if (/MediaRenderer/i.test(`${s.st ?? ""} ${s.deviceType ?? ""}`)) {
      options.push({
        priority: 3,
        name: s.friendlyName ?? "UPnP media renderer",
        device_class: "media",
        icon: "tv",
        vendor: s.manufacturer,
        model: s.modelName,
        support: "unsupported",
        reason: "UPnP/DLNA media renderers are not supported by GHOST v0.1.",
        kind: "upnp-media",
      });
    } else if (/InternetGatewayDevice/i.test(`${s.st ?? ""} ${s.deviceType ?? ""}`)) {
      options.push({
        priority: 6,
        name: s.friendlyName ?? "Router",
        device_class: "other",
        icon: "router",
        vendor: s.manufacturer,
        model: s.modelName,
        support: "unsupported",
        reason: "This is the network router (UPnP gateway). GHOST does not manage network equipment.",
        kind: "router",
      });
    } else if (s.friendlyName || s.manufacturer) {
      options.push({
        priority: 7,
        name: s.friendlyName ?? `${s.manufacturer} device`,
        device_class: "other",
        icon: "radio",
        vendor: s.manufacturer,
        model: s.modelName,
        support: "unsupported",
        reason: "Announces itself over UPnP but has no driver in GHOST v0.1.",
        kind: "upnp",
      });
    }
  }
  if (!options.length) {
    const http = host.mdns.find((m) => m.type === "http");
    if (http || host.extra) {
      options.push({
        priority: 8,
        name: http ? cleanName(http.name) : `Host ${host.key}`,
        device_class: "other",
        icon: "globe",
        support: "unsupported",
        reason: "Answers HTTP but did not match any supported device API (Shelly, WLED, Tasmota, Hue, Elgato, Roku, Kasa).",
        kind: "http",
      });
    }
  }
  if (!options.length) return null;
  options.sort((a, b) => a.priority - b.priority);
  const best = options[0];
  const kinds = [...new Set(options.map((o) => o.kind))];
  return candidate({
    local_key: `seen:${best.kind}:${host.key}`,
    name: best.name || `Device at ${host.ip}`,
    device_class: best.device_class,
    vendor: best.vendor,
    model: best.model,
    icon: best.icon,
    meta: {
      driver: "candidate",
      support: best.support,
      ip: host.ip,
      port: host.port,
      reason: best.reason,
      instructions: best.instructions,
      protocols: kinds,
      services: host.mdns.map((m) => `_${m.type}._tcp`).filter((v, i, a) => a.indexOf(v) === i),
      discovered_via: [...host.via],
    },
  });
}
