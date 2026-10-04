/**
 * Kernel cloud-browser adapter: any public web page (e.g. a live webcam page found by Exa)
 * becomes a device with one capability, `web.observe`, that screenshots the page.
 *
 * Devices are published as `status: "candidate"` (found on the web, not yet proven). The
 * coordinator may promote them after a successful observation. Provenance = the page URL.
 */
import { createHash } from "node:crypto";
import type { CapabilitySpec, Device, DeviceManifest, GeoPoint } from "../../contracts";
import { PROTOCOL_VERSION } from "../../contracts";
import { describeError, NotConfiguredError, PartnerError } from "../partners/common";
import { DEFAULT_WAIT_MS, kernelConfigured, MAX_WAIT_MS, observePage } from "../partners/kernel";
import { GhostError } from "../util";
import type { AdapterDiscovery, AdapterResult, InternalAdapter } from "./types";

export const KERNEL_ADAPTER_ID = "kernel";
export const WEB_OBSERVE = "web.observe";

export const webObserveCapability: CapabilitySpec = {
  capability_id: WEB_OBSERVE,
  kind: "observe",
  semantic_type: "image.observe",
  title: "Screenshot the public web page",
  description:
    "Opens the page in a Kernel cloud browser, waits, and returns a screenshot as an image observation. " +
    "It is a real capture of the operator's page at captured_at; the page may itself show a delayed or cached feed. " +
    "Public pages only: no logins, paywalls or CAPTCHAs.",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Public http(s) page URL. Defaults to the device's page (meta.url)." },
      wait_ms: {
        type: "number",
        minimum: 0,
        maximum: MAX_WAIT_MS,
        default: DEFAULT_WAIT_MS,
        description: "How long to let the page (and its video/image feed) load before the screenshot.",
      },
      full_page: { type: "boolean", default: false, description: "Capture the full scrollable page instead of the viewport." },
    },
    additionalProperties: false,
  },
  output: { media: "image/jpeg" },
  limits: { rate_per_min: 6 },
  verification: "observation",
  exclusive: false,
  estimated_ms: 9000,
};

/** Stable local key for a page URL (same URL -> same device). */
export function webLocalKey(url: string): string {
  const u = new URL(url);
  u.hash = "";
  return `web:${createHash("sha256").update(u.toString()).digest("hex").slice(0, 20)}`;
}

/** Build a candidate device for a public web page that Kernel can observe. */
export function webPageDiscovery(args: {
  url: string;
  title?: string | null;
  description?: string | null;
  kind?: "webcam" | "page";
  discovered_via?: string;
  query?: string;
  location?: GeoPoint;
  zone_id?: string;
}): AdapterDiscovery {
  const u = new URL(args.url);
  u.hash = "";
  const host = u.hostname.replace(/^www\./, "");
  const isCam = args.kind === "webcam";
  const name = (args.title?.trim() || `${isCam ? "Webcam page" : "Web page"} on ${host}`).slice(0, 110);
  const manifest: DeviceManifest = {
    protocol_version: PROTOCOL_VERSION,
    local_key: webLocalKey(u.toString()),
    name,
    device_class: isCam ? "camera" : "media",
    transport: "http-public",
    vendor: host,
    access_type: "public_observation",
    terms: {
      price_cents: 0,
      currency: "USD",
      max_duration_s: 600,
      note: "Public web page observed through a Kernel cloud browser. Respect the operator's terms of use.",
    },
    capabilities: [webObserveCapability],
    source: {
      operator: host,
      url: u.toString(),
      attribution: `Page by ${host}${args.discovered_via ? `; found via ${args.discovered_via}` : ""}; rendered by Kernel cloud browser`,
    },
    icon: isCam ? "webcam" : "globe",
    location: args.location,
    zone_id: args.zone_id,
    meta: {
      url: u.toString(),
      discovered_via: args.discovered_via ?? null,
      query: args.query ?? null,
      description: args.description ?? null,
      verified_by: "first successful web.observe screenshot",
    },
  };
  return { manifest, status: "candidate", online: kernelConfigured(), owner_id: "provider:kernel" };
}

export const kernelAdapter: InternalAdapter = {
  id: KERNEL_ADAPTER_ID,
  owner_id: "provider:kernel",

  async invoke(device: Device, capability_id: string, args: Record<string, unknown>, ctx): Promise<AdapterResult> {
    if (capability_id !== WEB_OBSERVE) return { state: "rejected", error: `unknown capability ${capability_id}` };
    const deviceUrl = typeof device.meta?.url === "string" ? device.meta.url : device.source?.url;
    const url = typeof args.url === "string" && args.url.trim() ? args.url.trim() : deviceUrl;
    if (!url) return { state: "rejected", error: "no url: pass arguments.url or use a device with meta.url" };
    // A device stands for one operator's page: overrides must stay on that host, so a success
    // (which promotes the device to "verified") is evidence about this device, not another site.
    if (deviceUrl && url !== deviceUrl) {
      try {
        if (new URL(url).hostname.replace(/^www\./, "") !== new URL(deviceUrl).hostname.replace(/^www\./, ""))
          return { state: "rejected", error: `this device observes ${new URL(deviceUrl).hostname}; use POST /partners/kernel/observe {url} for other sites` };
      } catch {
        return { state: "rejected", error: "url is not a valid URL" };
      }
    }
    if (args.wait_ms !== undefined && (typeof args.wait_ms !== "number" || args.wait_ms < 0 || args.wait_ms > MAX_WAIT_MS)) {
      return { state: "rejected", error: `wait_ms must be a number between 0 and ${MAX_WAIT_MS}` };
    }
    if (args.full_page !== undefined && typeof args.full_page !== "boolean") {
      return { state: "rejected", error: "full_page must be a boolean" };
    }
    try {
      const shot = await observePage(url, {
        wait_ms: args.wait_ms as number | undefined,
        full_page: args.full_page as boolean | undefined,
        signal: ctx.signal,
      });
      const host = new URL(shot.final_url).hostname.replace(/^www\./, "");
      return {
        state: "succeeded",
        observation: {
          kind: "image",
          media: { bytes: shot.bytes, content_type: shot.content_type },
          captured_at: shot.captured_at,
          source: {
            name: shot.title ? `${shot.title} (${host})` : host,
            url: shot.final_url,
            attribution: `Screenshot of ${host} via Kernel cloud browser`,
          },
          note:
            "Screenshot of the operator's public page taken at captured_at (a real capture of the page at that time). " +
            "The page may itself show a delayed or cached feed." +
            (shot.focused_media
              ? ` Centred on the page's main ${shot.focused_media.tag} (${shot.focused_media.width}x${shot.focused_media.height}${shot.focused_media.src_host ? ` from ${shot.focused_media.src_host}` : ""}).`
              : " No video, player or large image was detected on the page: this shows the page itself, not necessarily a live view."),
          data: {
            live_view_url: shot.live_view_url,
            page_title: shot.title,
            requested_url: shot.requested_url,
            final_url: shot.final_url,
            http_status: shot.http_status,
            wait_ms: shot.wait_ms,
            focused_media: shot.focused_media,
            kernel_session_id: shot.session_id,
            renderer: "kernel",
          },
        },
      };
    } catch (e) {
      if (e instanceof NotConfiguredError) return { state: "failed", error: `${e.message}: ${e.setup}` };
      if (e instanceof GhostError) return { state: e.status === 499 ? "failed" : "rejected", error: e.message };
      if (e instanceof PartnerError) return { state: "failed", error: `Kernel: ${e.message}` };
      return { state: "failed", error: `Kernel: ${describeError(e)}` };
    }
  },

  async probe() {
    return kernelConfigured()
      ? { online: true }
      : { online: false, detail: "Kernel not configured: set KERNEL_API_KEY in .env.local" };
  },
};
