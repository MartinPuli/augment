/** Durable connection memory is derived from the catalog and actual invocation rows. */
import type { DeviceConnectionMemory, RememberedDeviceCall } from "../client/api-types";
import type { InvocationState } from "../contracts";
import { connectionGuide } from "../connection-guide";
import { db } from "./db";
import { listDevices } from "./registry";
import { iso, json, tokenize } from "./util";

type CallRow = { invocation_id: string; capability_id: string; arguments: unknown; state: InvocationState; observation_id: string | null; updated_at: unknown; input_label: string | null };

export async function recallDeviceConnections(
  principal_id: string,
  opts: { query?: string; device_id?: string; limit?: number } = {},
): Promise<DeviceConnectionMemory[]> {
  // Browsers and external agents share the same persisted owner identity and history.
  // Never return another visitor's arguments, even when this principal owns the device.
  const used = await db().query<{ device_id: string }>(
    `select distinct device_id from invocations where visitor_id = $1`, [principal_id],
  );
  const known = new Set(used.rows.map((r) => r.device_id));
  const words = tokenize(opts.query ?? "");
  const limit = Math.min(30, Math.max(1, Math.trunc(Number(opts.limit) || 10)));
  const devices = (await listDevices()).filter((d) => {
    if (d.owner_id !== principal_id && !known.has(d.device_id)) return false;
    if (opts.device_id && d.device_id !== opts.device_id) return false;
    const text = `${d.name} ${d.vendor ?? ""} ${d.model ?? ""} ${d.transport} ${d.capabilities.map((c) => `${c.capability_id} ${c.title} ${c.semantic_type}`).join(" ")}`.toLowerCase();
    return words.every((word) => text.includes(word));
  }).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, limit);

  return Promise.all(devices.map(async (device): Promise<DeviceConnectionMemory> => {
    const [counts, recent, successful] = await Promise.all([
      db().query<{ state: InvocationState; n: number }>(
        `select state, count(*)::int as n from invocations where visitor_id = $1 and device_id = $2 group by state`,
        [principal_id, device.device_id],
      ),
      db().query<CallRow>(
        `select i.invocation_id, i.capability_id, i.arguments, i.state, i.observation_id, i.updated_at, o.body->'data'->>'input_label' as input_label
         from invocations i left join observations o on o.observation_id = i.observation_id
         where i.visitor_id = $1 and i.device_id = $2 and i.state in ('succeeded','failed','rejected','unknown')
         order by i.updated_at desc limit 8`, [principal_id, device.device_id],
      ),
      db().query<CallRow>(
        `select distinct on (i.capability_id) i.invocation_id, i.capability_id, i.arguments, i.state, i.observation_id, i.updated_at, o.body->'data'->>'input_label' as input_label
         from invocations i left join observations o on o.observation_id = i.observation_id
         where i.visitor_id = $1 and i.device_id = $2 and i.state = 'succeeded'
         order by i.capability_id, i.updated_at desc limit 30`, [principal_id, device.device_id],
      ),
    ]);
    const total = Object.fromEntries(counts.rows.map((r) => [r.state, Number(r.n)]));
    const call = (r: CallRow): RememberedDeviceCall => ({
      invocation_id: r.invocation_id,
      capability_id: r.capability_id,
      arguments: json<Record<string, unknown>>(r.arguments),
      state: r.state,
      observation_id: r.observation_id,
      finished_at: iso(r.updated_at),
      available_now: device.online && device.status !== "unavailable" && device.capabilities.some((c) => c.capability_id === r.capability_id),
      ...(r.input_label ? { input_label: r.input_label } : {}),
    });
    return {
      device_id: device.device_id,
      name: device.name,
      online: device.online,
      status: device.status,
      transport: device.transport,
      guide: connectionGuide(device),
      capabilities: device.capabilities.map((c) => ({
        ref: `${device.device_id}/${c.capability_id}`,
        title: c.title,
        input_schema: c.input_schema,
        verification: c.verification,
      })),
      history: {
        succeeded: total.succeeded ?? 0,
        failed: (total.failed ?? 0) + (total.rejected ?? 0),
        unknown: total.unknown ?? 0,
        recent: recent.rows.map(call),
        last_successful: successful.rows.map(call),
      },
      reuse_rule: "Recheck online state, current schema and lease/owner permission before reuse. History is not authorization. A succeeded invocation with acknowledgment-only verification does not prove the physical result.",
    };
  }));
}
