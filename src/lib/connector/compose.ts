/**
 * Compose capability modules (camera, microphone, speaker, ...) into ONE device manifest + handler,
 * e.g. "Gabriele's phone" or "This laptop".
 */
import type { DeviceManifest } from "@/lib/ghost/contracts";
import { InvokeError, type CapabilityModule, type DriverDevice } from "./types";
import { makeManifest } from "./util";

export function composeDevice(
  base: Omit<DeviceManifest, "protocol_version" | "access_type" | "terms" | "capabilities"> &
    Partial<Pick<DeviceManifest, "access_type" | "terms">>,
  modules: CapabilityModule[],
): DriverDevice {
  const owner = new Map<string, CapabilityModule>();
  for (const m of modules) for (const c of m.capabilities) if (!owner.has(c.capability_id)) owner.set(c.capability_id, m);
  const manifest = makeManifest({
    ...base,
    capabilities: [...owner.entries()].map(([id, m]) => m.capabilities.find((c) => c.capability_id === id)!),
    meta: {
      ...(base.meta ?? {}),
      modules: modules.map((m) => m.id),
      module_connections: Object.fromEntries(modules.filter((m) => m.connection).map((m) => [m.id, m.connection])),
    },
  });
  const signalModule = modules.find((m) => m.onSignal);
  return {
    manifest,
    handler: (capability_id, args, ctx) => {
      const m = owner.get(capability_id);
      if (!m) return Promise.reject(new InvokeError(`capability "${capability_id}" is not enabled`, "rejected"));
      return m.handle(capability_id, args, ctx);
    },
    onSignal: signalModule?.onSignal,
    onRevoke: (lease_id) => {
      for (const m of modules) {
        try {
          m.onRevoke?.(lease_id);
        } catch {}
      }
    },
    // Modules are owned by the page; disposing the composite device does not close them.
    dispose: undefined,
  };
}
