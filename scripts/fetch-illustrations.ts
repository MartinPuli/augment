// Downloads the 3D icon illustrations (Thiings, https://www.thiings.co) into public/illustrations/
// so the UI serves them locally. The files are git-ignored: Thiings icons are free for personal use,
// and the whole collection needs a commercial licence, so they are never redistributed from this
// public repository. Missing files fall back to a line icon in the UI.
// Usage: pnpm exec tsx scripts/fetch-illustrations.ts [--force]
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ILLUSTRATIONS } from "../src/components/ui/illustrations";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "illustrations");
mkdirSync(outDir, { recursive: true });
const UA = { "user-agent": "ghost-fetch-illustrations/1.0" };

/** The thing's own image is the `imageUrl` right before its own `shareUrl` in the page data. */
async function imageUrl(slug: string): Promise<string> {
  const res = await fetch(`https://www.thiings.co/things/${slug}`, {
    headers: UA,
  });
  if (!res.ok) throw new Error(`page ${slug} → HTTP ${res.status}`);
  const html = (await res.text()).replace(/\\"/g, '"');
  const share = `"shareUrl":"https://www.thiings.co/things/${slug}"`;
  const at = html.indexOf(share);
  if (at < 0) throw new Error(`no thing "${slug}" on thiings.co`);
  const before = html.slice(Math.max(0, at - 600), at);
  const m = [...before.matchAll(/"imageUrl":"(https:\/\/[^"]+)"/g)].pop();
  if (!m) throw new Error(`no image for "${slug}"`);
  return m[1];
}

async function main() {
  const force = process.argv.includes("--force");
  let failed = 0;
  for (const [name, slug] of Object.entries(ILLUSTRATIONS)) {
    const dest = join(outDir, `${name}.png`);
    if (!force && existsSync(dest)) {
      console.log(`• ${name} already present`);
      continue;
    }
    try {
      const url = await imageUrl(slug);
      const res = await fetch(url, { headers: UA });
      if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
      const tmp = `${dest}.part`;
      writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
      renameSync(tmp, dest);
      console.log(`✓ ${name.padEnd(12)} ${(statSync(dest).size / 1e3).toFixed(0).padStart(5)} kB  ← thiings.co/things/${slug}`);
    } catch (e) {
      failed++;
      console.error(`✗ ${name}: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (failed) process.exitCode = 1;
}

void main();
