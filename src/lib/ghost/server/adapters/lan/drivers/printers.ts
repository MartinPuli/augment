/** Owner-configured OctoPrint and Moonraker printers; documented APIs, no raw G-code. */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { CapabilitySpec } from "../../../../contracts";
import type { AdapterDiscovery, ObservationInput } from "../../types";
import { lanManifest } from "../caps";
import { httpRaw, sleep } from "../net";
import type { LanDriver } from "../types";

const PrinterConfig = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  name: z.string().min(1).max(120),
  type: z.enum(["octoprint", "moonraker"]),
  url: z.string().url(),
  api_key_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  allow_job_control: z.boolean().default(false),
}).strict();
type Config = z.infer<typeof PrinterConfig>;
const ConfigList = z.array(PrinterConfig).max(16);

export async function printerConfigs(): Promise<Config[]> {
  const file = process.env.GHOST_PRINTERS_CONFIG;
  if (!file) return [];
  let entries: Config[];
  try { entries = ConfigList.parse(JSON.parse(await readFile(file, "utf8"))); }
  catch { throw new Error("Invalid GHOST_PRINTERS_CONFIG: expected a JSON array of printer configurations"); }
  const ids = new Set<string>();
  for (const item of entries) {
    const url = new URL(item.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`Printer ${item.id}: use an HTTP(S) base URL without credentials, query or fragment`);
    if (ids.has(item.id)) throw new Error(`Duplicate printer id: ${item.id}`);
    ids.add(item.id);
    if (item.api_key_env && !process.env[item.api_key_env]) throw new Error(`Printer ${item.id}: configured API key environment variable is missing`);
  }
  return entries;
}

class PrinterHttpError extends Error {
  constructor(readonly status: number) { super(`Printer returned HTTP ${status}`); }
}
async function request(config: Config, route: string, signal?: AbortSignal, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (config.api_key_env) headers["X-Api-Key"] = process.env[config.api_key_env]!;
  const res = await httpRaw(`${config.url.replace(/\/+$/, "")}${route}`, { method: body === undefined ? "GET" : "POST", body, headers, signal, timeoutMs: 4000 });
  if (!res.ok) { await res.body?.cancel(); throw new PrinterHttpError(res.status); }
  if (res.status === 204) return null;
  // Bound the response while reading, including servers that omit Content-Length.
  const reader = res.body?.getReader();
  if (!reader) throw new Error("Printer returned no JSON body");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 1024 * 1024) throw new Error("Printer response exceeds 1 MB");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (config.type === "moonraker" && result && typeof result === "object" && result.error != null) throw new Error("Printer API reported an error");
  return result;
}

const Numeric = z.number().finite().nullable().optional();
const Job = z.object({ state: z.string(), job: z.object({ file: z.object({ name: z.string().nullable().optional() }).optional() }).optional(), progress: z.object({ completion: Numeric }).optional() });
const Temperature = z.object({ actual: Numeric, target: Numeric });
const OctoState = z.object({ temperature: z.record(z.string(), Temperature).optional() });
const MoonState = z.object({ result: z.object({ eventtime: Numeric, status: z.object({ print_stats: z.object({ state: z.string(), filename: z.string().optional() }), display_status: z.object({ progress: Numeric }).optional(), extruder: z.object({ temperature: Numeric, target: Numeric }).optional(), heater_bed: z.object({ temperature: Numeric, target: Numeric }).optional() }) }) });
type Reading = { state: string; filename: string | null; progress_percent: number | null; temperatures_c: Record<string, { actual: number | null; target: number | null }>; provider_eventtime?: number | null };
const percent = (n: number | null | undefined) => typeof n === "number" && n >= 0 && n <= 100 ? n : null;
async function readStatus(c: Config, signal?: AbortSignal): Promise<Reading> {
  if (c.type === "octoprint") {
    const job = Job.parse(await request(c, "/api/job", signal));
    let printer: z.infer<typeof OctoState> = {};
    try { printer = OctoState.parse(await request(c, "/api/printer", signal)); }
    catch (e) { if (!(e instanceof PrinterHttpError && e.status === 409)) throw e; }
    return { state: job.state, filename: job.job?.file?.name ?? null, progress_percent: percent(job.progress?.completion), temperatures_c: Object.fromEntries(Object.entries(printer.temperature ?? {}).map(([key, t]) => [key, { actual: t.actual ?? null, target: t.target ?? null }])) };
  }
  const { result } = MoonState.parse(await request(c, "/printer/objects/query?print_stats&display_status&extruder&heater_bed", signal));
  const s = result.status;
  return { state: s.print_stats.state, filename: s.print_stats.filename || null, progress_percent: s.display_status?.progress == null ? null : percent(s.display_status.progress * 100),
    temperatures_c: Object.fromEntries((["extruder", "heater_bed"] as const).filter(key => !!s[key]).map(key => [key, { actual: s[key]?.temperature ?? null, target: s[key]?.target ?? null }])), provider_eventtime: result.eventtime ?? null };
}
function observation(c: Config, reading: Reading, note?: string): ObservationInput {
  return { kind: "state", value: reading.state, data: reading, captured_at: null, source: { name: `${c.name} via ${c.type}` }, note: note ?? "Printer controller state, not independent physical verification. Sensor capture time is unknown; Moonraker eventtime is a monotonic clock, not UTC." };
}
const Control = z.object({ action: z.enum(["pause", "resume", "cancel"]), expected_file: z.string().min(1).max(1024) }).strict();
const statusCap: CapabilitySpec = { capability_id: "printer.status", semantic_type: "printer.status", title: "Read print job and temperatures", description: "Read the printer controller's state, selected file, completion percent and reported temperatures in Celsius.", kind: "observe", input_schema: { type: "object", properties: {}, additionalProperties: false }, verification: "observation", exclusive: false, estimated_ms: 1000 };
const controlCap: CapabilitySpec = { capability_id: "printer.job.control", semantic_type: "printer.job.control", title: "Pause, resume or cancel a print", description: "Operate the current job only if its filename matches expected_file from a fresh status reading. Cancellation stops the job; resuming continues physical printing. State is read back from the controller.", kind: "act", input_schema: { type: "object", properties: { action: { type: "string", enum: ["pause", "resume", "cancel"] }, expected_file: { type: "string", minLength: 1, maxLength: 1024 } }, required: ["action", "expected_file"], additionalProperties: false }, verification: "reported_state", exclusive: true, estimated_ms: 2000, limits: { rate_per_min: 10 } };

export async function discoverPrinters(): Promise<{ discoveries: AdapterDiscovery[]; errors: string[] }> {
  const configs = await printerConfigs();
  const discoveries: AdapterDiscovery[] = []; const errors: string[] = [];
  await Promise.all(configs.map(async c => {
    try {
      const reading = await readStatus(c);
      discoveries.push({ manifest: lanManifest({ local_key: `printer:${c.id}`, name: c.name, device_class: "printer", vendor: c.type, icon: "printer", capabilities: [statusCap, ...(c.allow_job_control ? [controlCap] : [])], meta: { driver: c.type, printer_id: c.id, support: "supported", discovered_via: ["owner-config"] } }), status: "verified", online: !/offline|error|shutdown/i.test(reading.state) });
    } catch { errors.push(`Printer ${c.id} did not provide valid status; check its local connection and credentials`); }
  }));
  return { discoveries, errors };
}

function driver(type: Config["type"]): LanDriver {
  return { id: type, async invoke(_device, meta, capability, args, ctx) {
    let commandSent = false;
    try {
      const c = (await printerConfigs()).find(p => p.id === meta.printer_id && p.type === type);
      if (!c) return { state: "rejected", error: "This printer is no longer configured on the owner's gateway" };
      if (capability === "printer.status") {
        if (Object.keys(args).length) return { state: "rejected", error: "printer.status accepts no arguments" };
        return { state: "succeeded", observation: observation(c, await readStatus(c, ctx.signal)) };
      }
      if (capability !== "printer.job.control" || !c.allow_job_control) return { state: "rejected", error: "Printer job control is not enabled by its owner" };
      const input = Control.safeParse(args);
      if (!input.success) return { state: "rejected", error: "Use pause, resume or cancel with the expected_file from a fresh status reading" };
      const { action, expected_file } = input.data;
      const before = await readStatus(c, ctx.signal);
      if (before.filename !== expected_file) return { state: "rejected", error: "The selected print file changed; read status again before controlling the job" };
      const state = before.state.toLowerCase();
      if (!(action === "pause" ? state === "printing" : action === "resume" ? state === "paused" : ["printing", "paused"].includes(state))) return { state: "rejected", error: `Cannot ${action} a job in state ${before.state}` };
      ctx.signal.throwIfAborted();
      commandSent = true;
      if (c.type === "octoprint") await request(c, "/api/job", ctx.signal, action === "cancel" ? { command: "cancel" } : { command: "pause", action });
      else await request(c, `/printer/print/${action}`, ctx.signal, {});
      let after = before;
      for (let attempt = 0; attempt < 6; attempt++) {
        ctx.signal.throwIfAborted();
        after = await readStatus(c, ctx.signal);
        const target = action === "pause" ? ["paused"] : action === "resume" ? ["printing"] : c.type === "octoprint" ? ["operational"] : ["cancelled"];
        if (target.includes(after.state.toLowerCase()) && (action === "cancel" || after.filename === expected_file)) return { state: "succeeded", observation: observation(c, after, `Controller state read back after ${action}; this is not independent physical confirmation.`) };
        if (attempt < 5) await sleep(200);
      }
      return { state: "unknown", error: "Command was sent, but the requested state was not confirmed. Read printer.status before another action.", observation: observation(c, after) };
    } catch (e) {
      return { state: commandSent ? "unknown" : "failed", error: e instanceof PrinterHttpError ? e.message : "Printer did not return a valid response; check its local connection, credentials and controller state" };
    }
  }};
}
export const octoprintDriver = driver("octoprint");
export const moonrakerDriver = driver("moonraker");
