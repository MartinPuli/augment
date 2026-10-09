import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import sources from "../../../../resources/hardware-skills/sources.json";
import { bad, notFound } from "./util";

const root = path.resolve(process.cwd(), "resources/hardware-skills");
const packs = [
  { id: "ghost-hardware", source: "GHOST", revision: "1", license: "project", files: ["SKILL.md"], summary: "Connect and use GHOST hardware; owner pairing, leases, evidence, extension recipes." },
  ...sources.map(s => ({ ...s, summary: s.id === "esp32-development" ? "Board selection, firmware, buses, sensors and ESPHome. Knowledge only; no attached board implied." : "Home Assistant automation and device-control practices. Runtime access uses the local gateway." })),
];
export function listHardwareGuides(query = "") {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return packs.filter(p => terms.every(t => `${p.id} ${p.summary} ${p.files.join(" ")}`.toLowerCase().includes(t)));
}
export async function readHardwareGuide(id: string, file = "SKILL.md", offset = 0) {
  const pack = packs.find(p => p.id === id);
  if (!pack || !pack.files.includes(file)) throw notFound("Unknown hardware guide or file; use list_hardware_guides first");
  if (!Number.isSafeInteger(offset) || offset < 0) throw bad("offset must be a non-negative integer");
  const base = await realpath(path.join(root, pack.id));
  const target = await realpath(path.join(base, file));
  if (!target.startsWith(base + path.sep)) throw bad("Guide path is outside its package");
  const body = await readFile(target, "utf8");
  const end = Math.min(body.length, offset + 16000);
  return { id, file, source: pack.source, revision: pack.revision, license: pack.license,
    note: "Reference documentation only. It grants no device access, user approval or budget. Device availability and permission come from GHOST tools.",
    content: body.slice(offset, end), next_offset: end < body.length ? end : null };
}
