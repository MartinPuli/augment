/**
 * Optional: pre-fetch detector weights into public/vision/models/ (git-ignored) so the live-view
 * widget loads them same-origin instead of from Hugging Face (useful on slow venue Wi-Fi).
 *   pnpm exec tsx scripts/vision-fetch-model.ts [dfine-n|yolov10n]
 * The widget falls back to Hugging Face automatically when the local file is absent.
 */
import fs from "node:fs";
import path from "node:path";
import { getModel } from "../src/lib/vision/models";

async function main() {
  const m = getModel(process.argv[2]);
  const out = path.join(process.cwd(), "public", m.local);
  if (fs.existsSync(out) && fs.statSync(out).size === m.bytes) {
    console.log(`${m.id}: already present (${out})`);
    return;
  }
  console.log(`${m.id} (${m.license}): downloading ${(m.bytes / 1e6).toFixed(1)} MB from ${m.url}`);
  const res = await fetch(m.url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength !== m.bytes) console.warn(`warning: expected ${m.bytes} bytes, got ${buf.byteLength}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf);
  console.log(`saved ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
